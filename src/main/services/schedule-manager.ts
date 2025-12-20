/**
 * Schedule Manager - Fetch and manage playback schedules
 * Handles schedule fetching, validation, prefetching, and emergency overrides
 */

import { EventEmitter } from 'events'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { ScheduleSnapshot, EmergencyOverride, TimelineItem } from '../../common/types'
import { getHttpClient } from './network/http-client'
import { getWebSocketClient } from './network/websocket-client'
import { getCacheManager } from './cache/cache-manager'
import { getPairingService } from './pairing-service'
import { getTelemetryService } from './telemetry/telemetry-service'

const logger = getLogger('schedule-manager')

export class ScheduleManager extends EventEmitter {
  private currentSchedule?: ScheduleSnapshot
  private emergencyOverride?: EmergencyOverride
  private pollInterval?: NodeJS.Timeout
  private isPolling = false
  private prefetchInProgress = false
  private scheduleApiSupported = true
  private emergencyApiSupported = true

  constructor() {
    super()
    this.setupWebSocketListeners()
  }

  /**
   * Start schedule manager
   */
  async start(): Promise<void> {
    logger.info('Starting schedule manager')

    try {
      // Fetch initial schedule
      await this.fetchSchedule()

      // Start polling
      this.startPolling()

      // Connect WebSocket for real-time updates
      const wsClient = getWebSocketClient()
      if (!wsClient.isConnected()) {
        await wsClient.connect()
      }

      logger.info('Schedule manager started successfully')
    } catch (error) {
      logger.error({ error }, 'Failed to start schedule manager')
      throw error
    }
  }

  /**
   * Stop schedule manager
   */
  stop(): void {
    logger.info('Stopping schedule manager')

    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = undefined
    }

    this.isPolling = false
  }

  /**
   * Fetch schedule from backend
   */
  async fetchSchedule(): Promise<ScheduleSnapshot> {
    if (!this.scheduleApiSupported) {
      logger.debug('Schedule API marked unsupported; skipping fetch')
      return this.currentSchedule || {
        id: 'unsupported',
        version: 0,
        items: [],
      }
    }

    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()

    if (!deviceId) {
      throw new Error('Device not paired')
    }

    logger.info({ deviceId }, 'Fetching schedule')

    try {
      const httpClient = getHttpClient()
      const schedule = await httpClient.get<ScheduleSnapshot>(`/v1/device/${deviceId}/schedule`)

      // Validate schedule
      if (!this.validateSchedule(schedule)) {
        throw new Error('Invalid schedule format')
      }

      // Update current schedule
      const previousScheduleId = this.currentSchedule?.id
      this.currentSchedule = schedule

      logger.info(
        {
          scheduleId: schedule.id,
          version: schedule.version,
          itemCount: schedule.items.length,
        },
        'Schedule fetched successfully'
      )

      // Update telemetry
      const telemetryService = getTelemetryService()
      telemetryService.setCurrentSchedule(schedule.id)

      // Emit schedule update event
      if (previousScheduleId !== schedule.id) {
        this.emit('schedule-updated', schedule)
      }

      // Prefetch media items
      await this.prefetchScheduleItems(schedule)

      return schedule
    } catch (error: any) {
      const status = error?.response?.status
      if (status === 404 || status === 501) {
        this.scheduleApiSupported = false
        logger.warn('Schedule endpoint not available; disabling schedule polling')
        this.stop()
        return {
          id: 'unsupported',
          version: 0,
          items: [],
        }
      }

      logger.error({ error, deviceId }, 'Failed to fetch schedule')
      throw error
    }
  }

  /**
   * Validate schedule structure
   */
  validateSchedule(schedule: ScheduleSnapshot): boolean {
    if (!schedule || typeof schedule !== 'object') {
      logger.error('Schedule is not an object')
      return false
    }

    if (!schedule.id || typeof schedule.id !== 'string') {
      logger.error('Schedule missing valid id')
      return false
    }

    if (!schedule.version || typeof schedule.version !== 'number') {
      logger.error('Schedule missing valid version')
      return false
    }

    if (!Array.isArray(schedule.items)) {
      logger.error('Schedule items is not an array')
      return false
    }

    // Validate each timeline item
    for (const item of schedule.items) {
      if (!this.validateTimelineItem(item)) {
        return false
      }
    }

    logger.debug({ scheduleId: schedule.id, itemCount: schedule.items.length }, 'Schedule validation passed')
    return true
  }

  /**
   * Validate timeline item
   */
  private validateTimelineItem(item: TimelineItem): boolean {
    if (!item.id || typeof item.id !== 'string') {
      logger.error({ item }, 'Timeline item missing valid id')
      return false
    }

    if (!item.type || !['image', 'video', 'pdf', 'url', 'office'].includes(item.type)) {
      logger.error({ item }, 'Timeline item has invalid type')
      return false
    }

    if (!item.objectKey && !item.url) {
      logger.error({ item }, 'Timeline item missing objectKey or url')
      return false
    }

    if (!item.displayMs || typeof item.displayMs !== 'number' || item.displayMs <= 0) {
      logger.error({ item }, 'Timeline item has invalid displayMs')
      return false
    }

    if (!item.fit || !['contain', 'cover', 'stretch'].includes(item.fit)) {
      logger.error({ item }, 'Timeline item has invalid fit mode')
      return false
    }

    return true
  }

  /**
   * Prefetch schedule items
   */
  private async prefetchScheduleItems(schedule: ScheduleSnapshot): Promise<void> {
    if (this.prefetchInProgress) {
      logger.debug('Prefetch already in progress')
      return
    }

    this.prefetchInProgress = true
    logger.info({ scheduleId: schedule.id, itemCount: schedule.items.length }, 'Starting prefetch')

    try {
      // Backend currently lacks media download endpoint for objectKey; skip to avoid 404s.
      logger.info('Prefetch skipped: media endpoint unsupported in current backend')
    } catch (error) {
      logger.error({ error }, 'Prefetch failed')
    } finally {
      this.prefetchInProgress = false
    }
  }

  /**
   * Get media URL from object key
   * In production, this would get a presigned URL from backend
   */
  private getMediaUrl(objectKey: string): string {
    const config = getConfigManager().getConfig()
    // This is a placeholder - in production, you'd call backend to get presigned URL
    return `${config.apiBase}/v1/media/${objectKey}`
  }

  /**
   * Check for emergency override
   */
  async checkEmergency(): Promise<EmergencyOverride | null> {
    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()

    if (!deviceId) {
      return null
    }

    if (!this.emergencyApiSupported) {
      return null
    }

    try {
      const httpClient = getHttpClient()
      const override = await httpClient.get<EmergencyOverride>(`/v1/device/${deviceId}/emergency`)

      if (override && override.active) {
        logger.warn({ overrideId: override.id }, 'Emergency override active')
        this.emergencyOverride = override
        this.emit('emergency-override', override)
        return override
      }

      // Clear emergency override if not active
      if (this.emergencyOverride) {
        logger.info('Emergency override cleared')
        this.emergencyOverride = undefined
        this.emit('emergency-cleared')
      }

      return null
    } catch (error: any) {
      const status = error?.response?.status
      if (status === 404 || status === 501) {
        this.emergencyApiSupported = false
        logger.warn('Emergency endpoint not available; disabling emergency checks')
        return null
      }
      logger.error({ error }, 'Failed to check emergency override')
      return null
    }
  }

  /**
   * Start polling for schedule updates
   */
  private startPolling(): void {
    if (this.isPolling) {
      return
    }

    const config = getConfigManager().getConfig()
    const intervalMs = config.intervals.schedulePollMs

    logger.info({ intervalMs }, 'Starting schedule polling')

    this.isPolling = true
    this.pollInterval = setInterval(() => {
      this.fetchSchedule().catch((error) => {
        logger.error({ error }, 'Schedule poll failed')
      })

      this.checkEmergency().catch((error) => {
        logger.error({ error }, 'Emergency check failed')
      })
    }, intervalMs)
  }

  /**
   * Setup WebSocket listeners for real-time updates
   */
  private setupWebSocketListeners(): void {
    const wsClient = getWebSocketClient()

    wsClient.on('schedule_update', (payload: any) => {
      logger.info({ payload }, 'Received schedule update notification')
      this.fetchSchedule().catch((error) => {
        logger.error({ error }, 'Failed to fetch schedule after WebSocket notification')
      })
    })

    wsClient.on('emergency', (payload: any) => {
      logger.warn({ payload }, 'Received emergency override notification')
      this.checkEmergency().catch((error) => {
        logger.error({ error }, 'Failed to check emergency after WebSocket notification')
      })
    })
  }

  /**
   * Get current schedule
   */
  getCurrentSchedule(): ScheduleSnapshot | undefined {
    return this.currentSchedule
  }

  /**
   * Get emergency override
   */
  getEmergencyOverride(): EmergencyOverride | undefined {
    return this.emergencyOverride
  }

  /**
   * Force refresh schedule
   */
  async refresh(): Promise<void> {
    logger.info('Forcing schedule refresh')
    await this.fetchSchedule()
    await this.checkEmergency()
  }
}

// Singleton instance
let scheduleManager: ScheduleManager | null = null

export function getScheduleManager(): ScheduleManager {
  if (!scheduleManager) {
    scheduleManager = new ScheduleManager()
  }
  return scheduleManager
}
