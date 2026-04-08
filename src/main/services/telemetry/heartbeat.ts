/**
 * Heartbeat - Periodic heartbeat sender with backpressure handling
 */

import { getLogger } from '../../../common/logger'
import { getConfigManager } from '../../../common/config'
import { Command, DeviceApiError, HeartbeatPayload, SystemStats } from '../../../common/types'
import { getHttpClient } from '../network/http-client'
import { getRequestQueue } from '../network/request-queue'
import { getPairingService } from '../pairing-service'
import { getSystemStatsCollector } from './system-stats'
import { getDeviceStateStore } from '../device-state-store'
import { getLifecycleEvents } from '../lifecycle-events'
import { getCommandProcessor } from '../command-processor'
import { getPlayerMetrics } from './player-metrics'

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
      this.sendHeartbeat().catch((error: unknown) => {
        logger.error({ error }, 'Failed to send heartbeat')
      })
    }, intervalMs)

    // Send initial heartbeat
    this.sendHeartbeat().catch((error: unknown) => {
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

  async sendImmediate(): Promise<void> {
    await this.sendHeartbeat()
  }

  private toMegabytes(value: number): number {
    return Math.round((value / (1024 * 1024)) * 10) / 10
  }

  private toGigabytes(value: number): number {
    return Math.round((value / (1024 * 1024 * 1024)) * 100) / 100
  }

  private buildHeartbeatPayload(
    deviceId: string,
    status: 'ONLINE' | 'OFFLINE' | 'ERROR',
    stats: {
      uptime: number
      memoryUsage: number
      memoryTotal: number
      memoryFree: number
      cpuUsage: number
      cpuCores: number
      cpuLoad1m: number
      cpuLoad5m: number
      cpuLoad15m: number
      diskUsage: number
      diskTotal: number
      diskFree: number
      temperature?: number
      primaryNetworkAddress?: string
      primaryNetworkInterface?: string
      displayCount: number
      displays: Array<{
        id?: string
        width: number
        height: number
        refresh_rate_hz?: number
        orientation?: 'portrait' | 'landscape'
        connected?: boolean
        model?: string
      }>
      hostname: string
      osVersion: string
      batteryPercent?: number
      isCharging?: boolean
      powerSource?: 'AC' | 'BATTERY' | 'USB' | 'UNKNOWN'
    }
  ): HeartbeatPayload {
    const memoryUsagePercent =
      stats.memoryTotal > 0 ? Math.round((stats.memoryUsage / stats.memoryTotal) * 1000) / 10 : 0
    const diskUsagePercent =
      stats.diskTotal > 0 ? Math.round((stats.diskUsage / stats.diskTotal) * 1000) / 10 : undefined

    return {
      device_id: deviceId,
      status,
      uptime: stats.uptime,
      memory_usage: memoryUsagePercent,
      cpu_usage: Math.round(stats.cpuUsage * 100) / 100,
      temperature: stats.temperature,
      current_schedule_id: this.currentScheduleId,
      current_media_id: this.currentMediaId,
      memory_total_mb: this.toMegabytes(stats.memoryTotal),
      memory_used_mb: this.toMegabytes(stats.memoryUsage),
      memory_free_mb: this.toMegabytes(stats.memoryFree),
      cpu_cores: stats.cpuCores,
      cpu_load_1m: Math.round(stats.cpuLoad1m * 100) / 100,
      cpu_load_5m: Math.round(stats.cpuLoad5m * 100) / 100,
      cpu_load_15m: Math.round(stats.cpuLoad15m * 100) / 100,
      cpu_temp_c: stats.temperature,
      disk_total_gb: this.toGigabytes(stats.diskTotal),
      disk_used_gb: this.toGigabytes(stats.diskUsage),
      disk_free_gb: this.toGigabytes(stats.diskFree),
      disk_usage_percent: diskUsagePercent,
      network_ip: stats.primaryNetworkAddress,
      network_interface: stats.primaryNetworkInterface,
      display_count: stats.displayCount,
      displays: stats.displays,
      os_version: stats.osVersion,
      hostname: stats.hostname,
      player_uptime_seconds: Math.round(process.uptime()),
      battery_percent: stats.batteryPercent,
      is_charging: stats.isCharging,
      power_source: stats.powerSource,
    }
  }

  /**
   * Send heartbeat to backend
   */
  private async sendHeartbeat(): Promise<void> {
    const startedAt = Date.now()
    let stats: SystemStats | undefined
    const metrics = getPlayerMetrics()

    try {
      const pairingService = getPairingService()
      if (!pairingService.isPairedDevice()) {
        logger.debug('Device not paired, skipping heartbeat')
        metrics.safeRecordHeartbeat('skipped_unpaired', (Date.now() - startedAt) / 1000)
        return
      }

      const deviceId = pairingService.getDeviceId()
      if (!deviceId) {
        logger.warn('No device ID available')
        metrics.safeRecordHeartbeat('missing_device_id', (Date.now() - startedAt) / 1000)
        return
      }

      // Collect system stats
      const statsCollector = getSystemStatsCollector()
      stats = await statsCollector.collect()

      // Prepare heartbeat payload
      const payload = this.buildHeartbeatPayload(deviceId, 'ONLINE', stats)

      // Send heartbeat
      const httpClient = getHttpClient()
      const response = await httpClient.post<{ success: boolean; timestamp?: string; commands?: Command[] }>(
        '/api/v1/device/heartbeat',
        payload,
        {
          retryPolicy: {
            maxAttempts: 3,
            baseDelayMs: 2000,
            maxDelayMs: 30000,
          },
        }
      )

      await getDeviceStateStore().update({
        lastHeartbeatAt: response.timestamp || new Date().toISOString(),
      })
      metrics.setLastSuccessfulHeartbeat(response.timestamp || Date.now())

      if (Array.isArray(response.commands) && response.commands.length > 0) {
        await getCommandProcessor().ingestCommands(response.commands, 'heartbeat')
      }

      logger.debug({ deviceId }, 'Heartbeat sent successfully')
      metrics.safeRecordHeartbeat('success', (Date.now() - startedAt) / 1000)
    } catch (error) {
      if (
        error instanceof DeviceApiError &&
        (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
      ) {
        getLifecycleEvents().emitRuntimeAuthFailure({
          source: 'heartbeat',
          error,
        })
        metrics.safeRecordHeartbeat('auth_failure', (Date.now() - startedAt) / 1000)
        return
      }

      logger.error({ error }, 'Failed to send heartbeat')

      // Queue for later if offline
      const requestQueue = getRequestQueue()
      try {
        await requestQueue.enqueue({
          method: 'POST',
          url: '/api/v1/device/heartbeat',
          data:
            stats && getPairingService().getDeviceId()
              ? this.buildHeartbeatPayload(getPairingService().getDeviceId() as string, 'OFFLINE', stats)
              : {
                  device_id: getPairingService().getDeviceId(),
                  status: 'OFFLINE',
                  uptime: 0,
                  memory_usage: 0,
                  cpu_usage: 0,
                },
          maxRetries: 3,
        })
        metrics.safeRecordHeartbeat('queued', (Date.now() - startedAt) / 1000)
      } catch (queueError) {
        metrics.safeRecordHeartbeat('failed', (Date.now() - startedAt) / 1000)
        throw queueError
      }
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
