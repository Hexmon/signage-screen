/**
 * Screenshot Service - Capture and upload screenshots
 * Captures current display and uploads to MinIO via presigned URL
 */

import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { getHttpClient } from './network/http-client'
import { getPairingService } from './pairing-service'
import { getRequestQueue } from './network/request-queue'
import { atomicWrite, ensureDir, generateId } from '../../common/utils'

const logger = getLogger('screenshot-service')

export class ScreenshotService {
  private mainWindow?: BrowserWindow
  private screenshotDir: string

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

  /**
   * Capture screenshot
   */
  async capture(): Promise<Buffer> {
    if (!this.mainWindow) {
      throw new Error('Screenshot service not initialized with main window')
    }

    logger.info('Capturing screenshot')

    try {
      // Capture screenshot using Electron's native capture
      const image = await this.mainWindow.webContents.capturePage()

      // Convert to PNG buffer
      const buffer = image.toPNG()

      logger.info({ size: buffer.length }, 'Screenshot captured')

      return buffer
    } catch (error) {
      logger.error({ error }, 'Failed to capture screenshot')
      throw error
    }
  }

  /**
   * Save screenshot to disk
   */
  async saveScreenshot(buffer: Buffer): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `screenshot-${timestamp}-${generateId(8)}.png`
    const filepath = path.join(this.screenshotDir, filename)

    logger.debug({ filepath }, 'Saving screenshot')

    try {
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
    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()

    if (!deviceId) {
      throw new Error('Device not paired')
    }

    logger.info({ filepath }, 'Uploading screenshot')

    const timestamp = new Date().toISOString()

    try {
      const httpClient = getHttpClient()
      const buffer = fs.readFileSync(filepath)
      const payload = {
        device_id: deviceId,
        timestamp,
        image_data: buffer.toString('base64'),
      }

      const response = await httpClient.post<{ success?: boolean; object_key?: string; timestamp?: string }>(
        '/api/v1/device/screenshot',
        payload
      )

      if (response?.success === false) {
        throw new Error('Screenshot upload rejected by server')
      }

      logger.info({ objectKey: response?.object_key }, 'Screenshot uploaded successfully')

      // Delete local file after successful upload
      fs.unlinkSync(filepath)

      return response?.object_key || ''
    } catch (error) {
      logger.error({ error, filepath }, 'Failed to upload screenshot, queuing for retry')

      // Queue payload for retry to avoid losing screenshots when offline
      try {
        const buffer = fs.readFileSync(filepath)
        const requestQueue = getRequestQueue()
        await requestQueue.enqueue({
          method: 'POST',
          url: '/api/v1/device/screenshot',
          data: {
            device_id: deviceId,
            timestamp,
            image_data: buffer.toString('base64'),
          },
          maxRetries: 3,
        })
        logger.info('Screenshot enqueued for retry')
      } catch (queueError) {
        logger.error({ error: queueError }, 'Failed to enqueue screenshot for retry')
      } finally {
        try {
          fs.unlinkSync(filepath)
        } catch {
          // ignore cleanup errors
        }
      }

      const message = (error as Error).message || 'Screenshot upload failed; queued for retry'
      throw new Error(`Screenshot upload failed; queued for retry: ${message}`)
    }
  }

  /**
   * Capture and upload screenshot (convenience method)
   */
  async captureAndUpload(): Promise<string> {
    logger.info('Capturing and uploading screenshot')

    try {
      // Capture screenshot
      const buffer = await this.capture()

      // Save to disk
      const filepath = await this.saveScreenshot(buffer)

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
  async cleanupOldScreenshots(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
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
}

// Singleton instance
let screenshotService: ScreenshotService | null = null

export function getScreenshotService(): ScreenshotService {
  if (!screenshotService) {
    screenshotService = new ScreenshotService()
  }
  return screenshotService
}
