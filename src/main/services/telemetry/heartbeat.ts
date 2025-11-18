/**
 * Heartbeat - Periodic heartbeat sender with backpressure handling
 */

import { getLogger } from '../../../common/logger'
import { getConfigManager } from '../../../common/config'
import { HeartbeatPayload } from '../../../common/types'
import { getHttpClient } from '../network/http-client'
import { getRequestQueue } from '../network/request-queue'
import { getPairingService } from '../pairing-service'
import { getSystemStatsCollector } from './system-stats'

const logger = getLogger('heartbeat')

export class HeartbeatService {
  private interval?: NodeJS.Timeout
  private isRunning = false
  private currentScheduleId?: string
  private currentMediaId?: string

  /**
   * Start heartbeat service
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Heartbeat service already running')
      return
    }

    const config = getConfigManager().getConfig()
    const intervalMs = config.intervals.heartbeatMs

    logger.info({ intervalMs }, 'Starting heartbeat service')

    this.isRunning = true
    this.interval = setInterval(() => {
      this.sendHeartbeat().catch((error) => {
        logger.error({ error }, 'Failed to send heartbeat')
      })
    }, intervalMs)

    // Send initial heartbeat
    this.sendHeartbeat().catch((error) => {
      logger.error({ error }, 'Failed to send initial heartbeat')
    })
  }

  /**
   * Stop heartbeat service
   */
  stop(): void {
    if (!this.isRunning) {
      return
    }

    logger.info('Stopping heartbeat service')

    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }

    this.isRunning = false
  }

  /**
   * Send heartbeat to backend
   */
  private async sendHeartbeat(): Promise<void> {
    let stats:
      | {
          uptime: number
          memoryUsage: number
          memoryTotal: number
          cpuUsage: number
          temperature?: number
        }
      | undefined

    try {
      const pairingService = getPairingService()
      if (!pairingService.isPairedDevice()) {
        logger.debug('Device not paired, skipping heartbeat')
        return
      }

      const deviceId = pairingService.getDeviceId()
      if (!deviceId) {
        logger.warn('No device ID available')
        return
      }

      // Collect system stats
      const statsCollector = getSystemStatsCollector()
      stats = await statsCollector.collect()

      // Prepare heartbeat payload
      const memoryUsagePercent =
        stats.memoryTotal > 0 ? Math.round((stats.memoryUsage / stats.memoryTotal) * 1000) / 10 : 0

      const payload: HeartbeatPayload = {
        device_id: deviceId,
        status: 'ONLINE',
        uptime: stats.uptime,
        memory_usage: memoryUsagePercent,
        cpu_usage: Math.round(stats.cpuUsage * 100) / 100,
        temperature: stats.temperature,
        current_schedule_id: this.currentScheduleId,
        current_media_id: this.currentMediaId,
      }

      // Send heartbeat
      const httpClient = getHttpClient()
      await httpClient.post('/v1/device/heartbeat', payload)

      logger.debug({ deviceId }, 'Heartbeat sent successfully')
    } catch (error) {
      logger.error({ error }, 'Failed to send heartbeat')

      // Queue for later if offline
      const requestQueue = getRequestQueue()
      await requestQueue.enqueue({
        method: 'POST',
        url: '/v1/device/heartbeat',
        data: {
          device_id: getPairingService().getDeviceId(),
          status: 'OFFLINE',
          uptime: stats?.uptime ?? 0,
          memory_usage: 0,
          cpu_usage: 0,
          temperature: stats?.temperature,
        },
        maxRetries: 3,
      })
    }
  }

  /**
   * Update current schedule ID
   */
  setCurrentSchedule(scheduleId: string): void {
    this.currentScheduleId = scheduleId
    logger.debug({ scheduleId }, 'Current schedule updated')
  }

  /**
   * Update current media ID
   */
  setCurrentMedia(mediaId: string): void {
    this.currentMediaId = mediaId
    logger.debug({ mediaId }, 'Current media updated')
  }

  /**
   * Clear current schedule and media
   */
  clearCurrent(): void {
    this.currentScheduleId = undefined
    this.currentMediaId = undefined
    logger.debug('Current schedule and media cleared')
  }

  /**
   * Check if running
   */
  isServiceRunning(): boolean {
    return this.isRunning
  }
}

// Singleton instance
let heartbeatService: HeartbeatService | null = null

export function getHeartbeatService(): HeartbeatService {
  if (!heartbeatService) {
    heartbeatService = new HeartbeatService()
  }
  return heartbeatService
}
