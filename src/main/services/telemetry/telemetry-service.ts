/**
 * Telemetry Service - Main orchestrator for telemetry collection and reporting
 */

import { getLogger } from '../../../common/logger'
import type { ActiveSlotPlayback } from '../../../common/types'
import { getSystemStatsCollector } from './system-stats'
import { getHeartbeatService } from './heartbeat'
import { getHealthServer } from './health-server'

const logger = getLogger('telemetry-service')

export class TelemetryService {
  private isRunning = false

  /**
   * Start telemetry service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Telemetry service already running')
      return
    }

    logger.info('Starting telemetry service')

    try {
      // Start health server
      const healthServer = getHealthServer()
      healthServer.start()

      // Start heartbeat service
      const heartbeatService = getHeartbeatService()
      heartbeatService.start()

      this.isRunning = true
      logger.info('Telemetry service started successfully')
    } catch (error) {
      logger.error({ error }, 'Failed to start telemetry service')
      throw error
    }
  }

  /**
   * Stop telemetry service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return
    }

    logger.info('Stopping telemetry service')

    try {
      // Stop heartbeat service
      const heartbeatService = getHeartbeatService()
      heartbeatService.stop()

      // Stop health server
      const healthServer = getHealthServer()
      healthServer.stop()

      this.isRunning = false
      logger.info('Telemetry service stopped successfully')
    } catch (error) {
      logger.error({ error }, 'Error stopping telemetry service')
    }
  }

  /**
   * Check if service is running
   */
  isServiceRunning(): boolean {
    return this.isRunning
  }

  /**
   * Get current system stats
   */
  async getSystemStats() {
    const statsCollector = getSystemStatsCollector()
    return await statsCollector.collect()
  }

  /**
   * Update current schedule
   */
  setCurrentSchedule(scheduleId: string): void {
    const heartbeatService = getHeartbeatService()
    heartbeatService.setCurrentSchedule(scheduleId)

    const healthServer = getHealthServer()
    healthServer.updateLastScheduleSync()
  }

  /**
   * Update current media
   */
  setCurrentMedia(mediaId: string): void {
    const heartbeatService = getHeartbeatService()
    heartbeatService.setCurrentMedia(mediaId)
  }

  setActivePlayback(sceneId: string | undefined, activeSlots: ActiveSlotPlayback[]): void {
    const heartbeatService = getHeartbeatService()
    heartbeatService.setActivePlayback(sceneId, activeSlots)
  }

  clearCurrentPlayback(): void {
    const heartbeatService = getHeartbeatService()
    heartbeatService.clearCurrent()
  }

  /**
   * Report error
   */
  reportError(error: string): void {
    const healthServer = getHealthServer()
    healthServer.addError(error)
  }
}

// Singleton instance
let telemetryService: TelemetryService | null = null

export function getTelemetryService(): TelemetryService {
  if (!telemetryService) {
    telemetryService = new TelemetryService()
  }
  return telemetryService
}
