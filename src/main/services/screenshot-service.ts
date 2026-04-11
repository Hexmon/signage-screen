/**
 * Screenshot Service - Capture and upload screenshots
 * Captures current display and uploads to MinIO via presigned URL
 */

import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow, nativeImage, NativeImage } from 'electron'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { DeviceApiError, ScreenshotPolicyResponse } from '../../common/types'
import { getHttpClient } from './network/http-client'
import { getPairingService } from './pairing-service'
import { getCertificateManager } from './cert-manager'
import { getRequestQueue } from './network/request-queue'
import { getLifecycleEvents } from './lifecycle-events'
import { atomicWrite, ensureDir, generateId } from '../../common/utils'
import { getPlayerMetrics } from './telemetry/player-metrics'

const logger = getLogger('screenshot-service')
const MAX_SCREENSHOT_UPLOAD_REQUEST_BYTES = Math.floor(3.5 * 1024 * 1024)
const SCREENSHOT_UPLOAD_URL = '/api/v1/device/screenshot'

export class ScreenshotService {
  private mainWindow?: BrowserWindow
  private screenshotDir: string
  private captureEnabled = false

  constructor() {
    const config = getConfigManager().getConfig()
    this.screenshotDir = path.join(config.cache.path, 'screenshots')
    ensureDir(this.screenshotDir, 0o755)
  }

  /**
   * Initialize with main window
   */
  initialize(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    logger.info('Screenshot service initialized')
  }

  setCaptureEnabled(enabled: boolean): void {
    this.captureEnabled = enabled
    logger.info({ enabled }, 'Updated screenshot capture policy')
  }

  isCaptureEnabled(): boolean {
    return this.captureEnabled
  }

  applyPolicy(
    policy: Partial<ScreenshotPolicyResponse> & { interval_ms?: number | null; intervalMs?: number | null }
  ): {
    enabled: boolean
    intervalMs?: number
  } {
    const enabled = policy.enabled === true
    this.setCaptureEnabled(enabled)

    if (!enabled) {
      return { enabled }
    }

    const rawIntervalMs =
      typeof policy.intervalMs === 'number'
        ? policy.intervalMs
        : typeof policy.interval_ms === 'number'
          ? policy.interval_ms
          : typeof policy.interval_seconds === 'number'
            ? policy.interval_seconds * 1000
            : undefined

    if (typeof rawIntervalMs !== 'number' || !Number.isFinite(rawIntervalMs)) {
      return { enabled }
    }

    const intervalMs = Math.max(10000, Math.round(rawIntervalMs))
    const configManager = getConfigManager()
    configManager.updateConfig({
      intervals: {
        ...configManager.getConfig().intervals,
        screenshotMs: intervalMs,
      },
    })

    return { enabled, intervalMs }
  }

  /**
   * Capture screenshot
   */
  async capture(): Promise<NativeImage> {
    if (!this.mainWindow) {
      throw new Error('Screenshot service not initialized with main window')
    }

    logger.info('Capturing screenshot')

    try {
      // Capture screenshot using Electron's native capture
      const image = await this.mainWindow.webContents.capturePage()

      logger.info({ size: image.toPNG().length }, 'Screenshot captured')

      return image
    } catch (error) {
      logger.error({ error }, 'Failed to capture screenshot')
      throw error
    }
  }

  /**
   * Save screenshot to disk
   */
  async saveScreenshot(image: NativeImage): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `screenshot-${timestamp}-${generateId(8)}.png`
    const filepath = path.join(this.screenshotDir, filename)

    logger.debug({ filepath }, 'Saving screenshot')

    try {
      const buffer = image.toPNG()
      await atomicWrite(filepath, buffer)
      logger.info({ filepath, size: buffer.length }, 'Screenshot saved')

      return filepath
    } catch (error) {
      logger.error({ error, filepath }, 'Failed to save screenshot')
      throw error
    }
  }

  /**
   * Upload screenshot to backend
   */
  async uploadScreenshot(filepath: string): Promise<string> {
    const metrics = getPlayerMetrics()
    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()

    if (!deviceId) {
      throw new Error('Device not paired')
    }

    const certManager = getCertificateManager()
    const certMetadata = certManager.getCertificateMetadata()
    if (!certMetadata?.serialNumber) {
      throw new Error('Device certificate not available; re-pair device to upload screenshots')
    }

    logger.info({ filepath }, 'Uploading screenshot')

    const timestamp = new Date().toISOString()

    try {
      const httpClient = getHttpClient()
      const buffer = fs.readFileSync(filepath)
      const preparedUpload = this.prepareUploadPayload(buffer, (candidateBuffer, mimeType) =>
        this.estimateUploadRequestSize(deviceId, timestamp, candidateBuffer, mimeType) <=
        MAX_SCREENSHOT_UPLOAD_REQUEST_BYTES
      )
      const payload = {
        device_id: deviceId,
        timestamp,
        image_data: preparedUpload.buffer.toString('base64'),
        mime_type: preparedUpload.mimeType,
      }

      const response = await httpClient.post<{ success?: boolean; object_key?: string; timestamp?: string }>(
        '/api/v1/device/screenshot',
        payload,
        {
          retryPolicy: {
            maxAttempts: 2,
            baseDelayMs: 2000,
            maxDelayMs: 15000,
          },
        }
      )

      if (response?.success === false) {
        throw new Error('Screenshot upload rejected by server')
      }

      logger.info({ objectKey: response?.object_key }, 'Screenshot uploaded successfully')
      metrics.recordScreenshotUpload('success')

      // Delete local file after successful upload
      fs.unlinkSync(filepath)

      return response?.object_key || ''
    } catch (error) {
      if (
        error instanceof DeviceApiError &&
        (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
      ) {
        getLifecycleEvents().emitRuntimeAuthFailure({
          source: 'screenshot',
          error,
        })
        metrics.recordScreenshotUpload('auth_failure')
        throw error
      }

      const message = (error as Error).message || 'Screenshot upload failed'
      const shouldQueue = !message.includes('exceeds upload size budget')
      let queuedForRetry = false

      logger.error({ error, filepath, shouldQueue }, 'Failed to upload screenshot')

      if (shouldQueue) {
        try {
          const requestQueue = getRequestQueue()
          const queueBudgetBytes = requestQueue.getBudgetSnapshot().categories.screenshot.maxBytes
          const preparedUpload = this.prepareUploadPayload(fs.readFileSync(filepath), (candidateBuffer, mimeType) =>
            this.estimateQueuedRequestSize(deviceId, timestamp, candidateBuffer, mimeType) <= queueBudgetBytes
          )
          queuedForRetry = await requestQueue.enqueue({
            method: 'POST',
            url: SCREENSHOT_UPLOAD_URL,
            data: {
              device_id: deviceId,
              timestamp,
              image_data: preparedUpload.buffer.toString('base64'),
              mime_type: preparedUpload.mimeType,
            },
            maxRetries: 3,
          })

          if (queuedForRetry) {
            logger.info('Screenshot enqueued for retry')
            metrics.recordScreenshotUpload('queued')
          } else {
            metrics.recordScreenshotUpload('failed')
          }
        } catch (queueError) {
          logger.error({ error: queueError }, 'Failed to enqueue screenshot for retry')
          metrics.recordScreenshotUpload('failed')
        }
      } else {
        metrics.recordScreenshotUpload('failed')
      }

      try {
        fs.unlinkSync(filepath)
      } catch {
        // ignore cleanup errors
      }

      if (queuedForRetry) {
        throw new Error(`Screenshot upload failed; queued for retry: ${message}`)
      }

      throw new Error(message)
    }
  }

  /**
   * Capture and upload screenshot (convenience method)
   */
  async captureAndUpload(): Promise<string> {
    logger.info('Capturing and uploading screenshot')

    try {
      // Capture screenshot
      const image = await this.capture()

      // Save to disk
      const filepath = await this.saveScreenshot(image)

      // Upload to backend
      const objectKey = await this.uploadScreenshot(filepath)

      logger.info({ objectKey }, 'Screenshot captured and uploaded successfully')

      return objectKey
    } catch (error) {
      logger.error({ error }, 'Failed to capture and upload screenshot')
      throw error
    }
  }

  /**
   * Cleanup old screenshots
   */
  cleanupOldScreenshots(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    logger.info({ maxAgeMs }, 'Cleaning up old screenshots')

    try {
      if (!fs.existsSync(this.screenshotDir)) {
        return
      }

      const files = fs.readdirSync(this.screenshotDir)
      const now = Date.now()
      let deletedCount = 0

      for (const file of files) {
        const filepath = path.join(this.screenshotDir, file)
        const stats = fs.statSync(filepath)

        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filepath)
          deletedCount++
        }
      }

      logger.info({ deletedCount }, 'Old screenshots cleaned up')
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup old screenshots')
    }
  }

  /**
   * Get screenshot directory
   */
  getScreenshotDirectory(): string {
    return this.screenshotDir
  }

  /**
   * List local screenshots
   */
  listLocalScreenshots(): string[] {
    try {
      if (!fs.existsSync(this.screenshotDir)) {
        return []
      }

      return fs
        .readdirSync(this.screenshotDir)
        .filter((file) => file.endsWith('.png'))
        .map((file) => path.join(this.screenshotDir, file))
    } catch (error) {
      logger.error({ error }, 'Failed to list local screenshots')
      return []
    }
  }

  private prepareUploadPayload(
    buffer: Buffer,
    fitsCandidate: (candidateBuffer: Buffer, mimeType: 'image/jpeg' | 'image/png') => boolean = (candidate) =>
      candidate.length <= MAX_SCREENSHOT_UPLOAD_REQUEST_BYTES
  ): { buffer: Buffer; mimeType: 'image/jpeg' | 'image/png' } {
    if (fitsCandidate(buffer, 'image/png')) {
      return { buffer, mimeType: 'image/png' }
    }

    const image = nativeImage.createFromBuffer(buffer)
    const originalSize = image.getSize()
    const scaleSteps = [1, 0.85, 0.7, 0.55, 0.4]
    const qualitySteps = [82, 72, 62, 52, 42]

    for (const scale of scaleSteps) {
      const width = Math.max(1, Math.round(originalSize.width * scale))
      const height = Math.max(1, Math.round(originalSize.height * scale))
      const candidate = scale === 1 ? image : image.resize({ width, height, quality: 'best' })

      for (const quality of qualitySteps) {
        const jpegBuffer = candidate.toJPEG(quality)
        if (fitsCandidate(jpegBuffer, 'image/jpeg')) {
          logger.info(
            {
              originalBytes: buffer.length,
              resizedBytes: jpegBuffer.length,
              width,
              height,
              quality,
            },
            'Compressed screenshot for upload'
          )
          return { buffer: jpegBuffer, mimeType: 'image/jpeg' }
        }
      }
    }

    throw new Error('Screenshot exceeds upload size budget even after compression')
  }

  private estimateUploadRequestSize(
    deviceId: string,
    timestamp: string,
    buffer: Buffer,
    mimeType: 'image/jpeg' | 'image/png'
  ): number {
    return Buffer.byteLength(
      JSON.stringify({
        device_id: deviceId,
        timestamp,
        image_data: buffer.toString('base64'),
        mime_type: mimeType,
      }),
      'utf8'
    )
  }

  private estimateQueuedRequestSize(
    deviceId: string,
    timestamp: string,
    buffer: Buffer,
    mimeType: 'image/jpeg' | 'image/png'
  ): number {
    return Buffer.byteLength(
      JSON.stringify({
        method: 'POST',
        url: SCREENSHOT_UPLOAD_URL,
        data: {
          device_id: deviceId,
          timestamp,
          image_data: buffer.toString('base64'),
          mime_type: mimeType,
        },
        headers: null,
      }),
      'utf8'
    )
  }
}

// Singleton instance
let screenshotService: ScreenshotService | null = null

export function getScreenshotService(): ScreenshotService {
  if (!screenshotService) {
    screenshotService = new ScreenshotService()
  }
  return screenshotService
}
