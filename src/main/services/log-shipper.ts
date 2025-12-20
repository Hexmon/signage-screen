/**
 * Log Shipper - Bundle and upload logs to backend
 * Compresses logs and uploads via presigned URL
 */

import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { promisify } from 'util'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { atomicWrite, ensureDir, generateId } from '../../common/utils'
import { getHttpClient } from './network/http-client'
import { getPairingService } from './pairing-service'

const gzipAsync = promisify(zlib.gzip)
const logger = getLogger('log-shipper')

export interface LogShipmentResult {
  success: boolean
  bundleId?: string
  uploadUrl?: string
  error?: string
}

export class LogShipper {
  private logDir: string
  private bundleDir: string
  private shipInterval?: NodeJS.Timeout
  private isShipping = false
  private presignUnsupported = false

  constructor() {
    const config = getConfigManager().getConfig()
    this.logDir = path.join(config.cache.path, 'logs')
    this.bundleDir = path.join(config.cache.path, 'log-bundles')

    ensureDir(this.logDir, 0o755)
    ensureDir(this.bundleDir, 0o755)

    logger.info({ logDir: this.logDir, bundleDir: this.bundleDir }, 'Log shipper initialized')
  }

  /**
   * Start automatic log shipping
   */
  start(intervalMs: number = 24 * 60 * 60 * 1000): void {
    // Default: ship logs once per day
    if (this.shipInterval) {
      logger.warn('Log shipper already running')
      return
    }

    logger.info({ intervalMs }, 'Starting log shipper')

    this.shipInterval = setInterval(() => {
      this.shipLogs().catch((error) => {
        logger.error({ error }, 'Automatic log shipping failed')
      })
    }, intervalMs)

    // Ship logs immediately on start
    this.shipLogs().catch((error) => {
      logger.error({ error }, 'Initial log shipping failed')
    })
  }

  /**
   * Stop automatic log shipping
   */
  stop(): void {
    if (!this.shipInterval) {
      return
    }

    logger.info('Stopping log shipper')

    clearInterval(this.shipInterval)
    this.shipInterval = undefined
  }

  /**
   * Ship logs to backend
   */
  async shipLogs(): Promise<LogShipmentResult> {
    if (this.isShipping) {
      logger.debug('Log shipping already in progress')
      return {
        success: false,
        error: 'Log shipping already in progress',
      }
    }

    if (this.presignUnsupported) {
      logger.warn('Log shipping disabled: presign endpoint unavailable')
      return { success: false, error: 'Presign unsupported' }
    }

    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()

    if (!deviceId) {
      logger.debug('Device not paired, skipping log shipping')
      return {
        success: false,
        error: 'Device not paired',
      }
    }

    this.isShipping = true
    logger.info('Starting log shipment')

    try {
      // Bundle logs
      const bundlePath = await this.bundleLogs()

      if (!bundlePath) {
        logger.info('No logs to ship')
        return {
          success: true,
        }
      }

      // Upload bundle
      const uploadUrl = await this.uploadBundle(bundlePath, deviceId)

      // Delete bundle after successful upload
      fs.unlinkSync(bundlePath)

      logger.info({ uploadUrl }, 'Log shipment completed successfully')

      return {
        success: true,
        bundleId: path.basename(bundlePath),
        uploadUrl,
      }
    } catch (error: any) {
      const status = error?.response?.status
      if (status === 404 || status === 501) {
        this.presignUnsupported = true
        logger.warn('Disabling log shipping; presign endpoint not available on backend')
      } else {
        logger.error({ error }, 'Log shipment failed')
      }
      return {
        success: false,
        error: (error as Error).message,
      }
    } finally {
      this.isShipping = false
    }
  }

  /**
   * Bundle logs into compressed archive
   */
  private async bundleLogs(): Promise<string | null> {
    logger.info('Bundling logs')

    try {
      // Get all log files
      const logFiles = this.getLogFiles()

      if (logFiles.length === 0) {
        logger.info('No log files to bundle')
        return null
      }

      // Create bundle
      const bundleId = generateId(16)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const bundleName = `logs-${timestamp}-${bundleId}.json.gz`
      const bundlePath = path.join(this.bundleDir, bundleName)

      // Collect log contents
      const logData: Record<string, string> = {}

      for (const logFile of logFiles) {
        try {
          const content = fs.readFileSync(logFile, 'utf-8')
          const relativePath = path.relative(this.logDir, logFile)
          logData[relativePath] = content
        } catch (error) {
          logger.warn({ error, logFile }, 'Failed to read log file')
        }
      }

      // Convert to JSON
      const jsonData = JSON.stringify(
        {
          bundleId,
          timestamp: new Date().toISOString(),
          deviceId: getPairingService().getDeviceId(),
          logs: logData,
        },
        null,
        2
      )

      // Compress
      const compressed = await gzipAsync(Buffer.from(jsonData, 'utf-8'))

      // Save bundle
      await atomicWrite(bundlePath, compressed)

      logger.info(
        {
          bundlePath,
          logFileCount: logFiles.length,
          originalSize: jsonData.length,
          compressedSize: compressed.length,
          compressionRatio: (compressed.length / jsonData.length).toFixed(2),
        },
        'Logs bundled successfully'
      )

      return bundlePath
    } catch (error) {
      logger.error({ error }, 'Failed to bundle logs')
      throw error
    }
  }

  /**
   * Get all log files
   */
  private getLogFiles(): string[] {
    try {
      if (!fs.existsSync(this.logDir)) {
        return []
      }

      const files = fs.readdirSync(this.logDir)
      return files
        .filter((f) => f.endsWith('.log') || f.endsWith('.log.gz'))
        .map((f) => path.join(this.logDir, f))
        .sort()
    } catch (error) {
      logger.error({ error }, 'Failed to get log files')
      return []
    }
  }

  /**
   * Upload bundle to backend
   */
  private async uploadBundle(bundlePath: string, deviceId: string): Promise<string> {
    logger.info({ bundlePath }, 'Uploading log bundle')

    try {
      const httpClient = getHttpClient()

      // Request presigned URL
      const response = await httpClient.post<{ upload_url: string; log_url: string }>(
        `/v1/device/${deviceId}/logs/presigned-url`,
        {
          filename: path.basename(bundlePath),
          content_type: 'application/gzip',
        }
      )

      const { upload_url, log_url } = response

      // Read bundle
      const buffer = fs.readFileSync(bundlePath)

      // Upload to presigned URL
      const axios = httpClient.getAxiosInstance()
      await axios.put(upload_url, buffer, {
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Length': buffer.length,
        },
      })

      logger.info({ logUrl: log_url, size: buffer.length }, 'Log bundle uploaded successfully')

      return log_url
    } catch (error) {
      logger.error({ error, bundlePath }, 'Failed to upload log bundle')
      throw error
    }
  }

  /**
   * Cleanup old bundles
   */
  async cleanupOldBundles(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    // Default: keep bundles for 7 days
    logger.info({ maxAgeMs }, 'Cleaning up old log bundles')

    try {
      if (!fs.existsSync(this.bundleDir)) {
        return 0
      }

      const files = fs.readdirSync(this.bundleDir)
      const now = Date.now()
      let deletedCount = 0

      for (const file of files) {
        const filepath = path.join(this.bundleDir, file)
        const stats = fs.statSync(filepath)

        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filepath)
          deletedCount++
          logger.debug({ file }, 'Deleted old bundle')
        }
      }

      logger.info({ deletedCount }, 'Old bundles cleaned up')
      return deletedCount
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup old bundles')
      return 0
    }
  }

  /**
   * Get bundle directory
   */
  getBundleDirectory(): string {
    return this.bundleDir
  }

  /**
   * List local bundles
   */
  listLocalBundles(): string[] {
    try {
      if (!fs.existsSync(this.bundleDir)) {
        return []
      }

      return fs
        .readdirSync(this.bundleDir)
        .filter((f) => f.startsWith('logs-') && f.endsWith('.json.gz'))
        .map((f) => path.join(this.bundleDir, f))
    } catch (error) {
      logger.error({ error }, 'Failed to list local bundles')
      return []
    }
  }

  /**
   * Check if shipping
   */
  isShippingLogs(): boolean {
    return this.isShipping
  }
}

// Singleton instance
let logShipper: LogShipper | null = null

export function getLogShipper(): LogShipper {
  if (!logShipper) {
    logShipper = new LogShipper()
  }
  return logShipper
}
