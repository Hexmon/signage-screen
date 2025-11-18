/**
 * Proof-of-Play Service - Track and report media playback events
 * Features: offline spooling, batch flushing, deduplication
 */

import * as fs from 'fs'
import * as path from 'path'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { ProofOfPlayEvent } from '../../common/types'
import { atomicWrite, ensureDir, generateId } from '../../common/utils'
import { getHttpClient } from './network/http-client'
import { getPairingService } from './pairing-service'

const logger = getLogger('pop-service')

interface ActivePlayback {
  scheduleId: string
  mediaId: string
  startTimestamp: string
}

export class ProofOfPlayService {
  private spoolPath: string
  private activePlaybacks: Map<string, ActivePlayback>
  private eventBuffer: ProofOfPlayEvent[]
  private maxBufferSize = 100
  private flushInterval?: NodeJS.Timeout
  private isFlushing = false
  private seenEvents: Set<string> // For deduplication

  constructor() {
    const config = getConfigManager().getConfig()
    this.spoolPath = path.join(config.cache.path, 'pop-spool')
    ensureDir(this.spoolPath, 0o755)

    this.activePlaybacks = new Map()
    this.eventBuffer = []
    this.seenEvents = new Set()

    // Load spooled events
    this.loadSpooledEvents()

    // Start periodic flush
    this.startPeriodicFlush()

    logger.info({ spoolPath: this.spoolPath }, 'Proof-of-Play service initialized')
  }

  /**
   * Record playback start
   */
  recordStart(scheduleId: string, mediaId: string): void {
    const key = `${scheduleId}:${mediaId}`
    const startTimestamp = new Date().toISOString()

    this.activePlaybacks.set(key, {
      scheduleId,
      mediaId,
      startTimestamp,
    })

    logger.debug({ scheduleId, mediaId, startTimestamp }, 'Playback started')
  }

  /**
   * Record playback end
   */
  recordEnd(scheduleId: string, mediaId: string, completed: boolean, errorMessage?: string): void {
    const key = `${scheduleId}:${mediaId}`
    const active = this.activePlaybacks.get(key)

    if (!active) {
      logger.warn({ scheduleId, mediaId }, 'No active playback found for end event')
      return
    }

    const endTimestamp = new Date().toISOString()
    const startTime = new Date(active.startTimestamp).getTime()
    const endTime = new Date(endTimestamp).getTime()
    const durationSeconds = Math.max(0, Math.round((endTime - startTime) / 1000))

    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()

    if (errorMessage) {
      logger.warn({ scheduleId, mediaId, errorMessage }, 'Playback ended with error message')
    }

    if (!deviceId) {
      logger.warn('No device ID available, cannot record PoP event')
      return
    }

    const event: ProofOfPlayEvent = {
      device_id: deviceId,
      schedule_id: scheduleId,
      media_id: mediaId,
      start_time: active.startTimestamp,
      end_time: endTimestamp,
      duration: durationSeconds,
      completed,
    }

    // Check for duplicate
    if (!this.isDuplicate(event)) {
      this.eventBuffer.push(event)
      logger.debug({ scheduleId, mediaId, durationSeconds, completed }, 'Playback ended')

      // Flush if buffer is full
      if (this.eventBuffer.length >= this.maxBufferSize) {
        this.flushEvents().catch((error) => {
          logger.error({ error }, 'Failed to flush events')
        })
      }
    } else {
      logger.debug({ scheduleId, mediaId }, 'Duplicate event detected, skipping')
    }

    this.activePlaybacks.delete(key)
  }

  /**
   * Check if event is duplicate
   */
  private isDuplicate(event: ProofOfPlayEvent): boolean {
    const key = `${event.device_id}:${event.media_id}:${event.start_time}`
    if (this.seenEvents.has(key)) {
      return true
    }
    this.seenEvents.add(key)

    // Limit seen events set size
    if (this.seenEvents.size > 10000) {
      // Clear oldest half
      const entries = Array.from(this.seenEvents)
      this.seenEvents = new Set(entries.slice(5000))
    }

    return false
  }

  /**
   * Spool events to disk
   */
  private async spoolEvents(events: ProofOfPlayEvent[]): Promise<void> {
    if (events.length === 0) {
      return
    }

    const spoolFile = path.join(this.spoolPath, `pop-${Date.now()}-${generateId(8)}.json`)

    try {
      await atomicWrite(spoolFile, JSON.stringify(events, null, 2))
      logger.debug({ spoolFile, count: events.length }, 'Events spooled to disk')
    } catch (error) {
      logger.error({ error, spoolFile }, 'Failed to spool events')
    }
  }

  /**
   * Load spooled events from disk
   */
  private loadSpooledEvents(): void {
    try {
      if (!fs.existsSync(this.spoolPath)) {
        return
      }

      const files = fs.readdirSync(this.spoolPath).filter((f) => f.startsWith('pop-') && f.endsWith('.json'))

      for (const file of files) {
        const filePath = path.join(this.spoolPath, file)
        try {
          const data = fs.readFileSync(filePath, 'utf-8')
          const events = JSON.parse(data) as ProofOfPlayEvent[]
          const normalizedEvents = events.map((event) => this.normalizeEvent(event)).filter(Boolean) as ProofOfPlayEvent[]
          this.eventBuffer.push(...normalizedEvents)
          logger.debug({ file, count: normalizedEvents.length }, 'Loaded spooled events')
        } catch (error) {
          logger.error({ error, file }, 'Failed to load spooled events')
        }
      }

      logger.info({ totalEvents: this.eventBuffer.length }, 'Spooled events loaded')
    } catch (error) {
      logger.error({ error }, 'Failed to load spooled events')
    }
  }

  /**
   * Flush events to backend
   */
  async flushEvents(): Promise<void> {
    if (this.isFlushing) {
      logger.debug('Already flushing events')
      return
    }

    if (this.eventBuffer.length === 0) {
      return
    }

    this.isFlushing = true
    logger.info({ count: this.eventBuffer.length }, 'Flushing PoP events')

    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()

    if (!deviceId) {
      logger.warn('No device ID available, spooling events')
      await this.spoolEvents(this.eventBuffer)
      this.eventBuffer = []
      this.isFlushing = false
      return
    }

    try {
      const httpClient = getHttpClient()
      const eventsToFlush = [...this.eventBuffer]
      const failedEvents: ProofOfPlayEvent[] = []

      for (const event of eventsToFlush) {
        try {
          const payload: ProofOfPlayEvent = {
            ...event,
            device_id: event.device_id || deviceId,
          }
          await httpClient.post('/v1/device/proof-of-play', payload)
        } catch (error) {
          logger.error({ error, event }, 'Failed to flush PoP event')
          failedEvents.push(event)
        }
      }

      if (failedEvents.length > 0) {
        await this.spoolEvents(failedEvents)
        logger.warn({ failed: failedEvents.length }, 'Some PoP events were spooled for later retry')
      } else {
        this.cleanupSpooledFiles()
        logger.info({ count: eventsToFlush.length }, 'PoP events flushed successfully')
      }

      this.eventBuffer = []
    } finally {
      this.isFlushing = false
    }
  }

  /**
   * Cleanup spooled files after successful flush
   */
  private cleanupSpooledFiles(): void {
    try {
      if (!fs.existsSync(this.spoolPath)) {
        return
      }

      const files = fs.readdirSync(this.spoolPath).filter((f) => f.startsWith('pop-') && f.endsWith('.json'))

      for (const file of files) {
        const filePath = path.join(this.spoolPath, file)
        fs.unlinkSync(filePath)
      }

      logger.debug({ count: files.length }, 'Spooled files cleaned up')
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup spooled files')
    }
  }

  /**
   * Start periodic flush
   */
  private startPeriodicFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flushEvents().catch((error) => {
        logger.error({ error }, 'Periodic flush failed')
      })
    }, 60000) // Flush every minute
  }

  /**
   * Stop periodic flush
   */
  stopPeriodicFlush(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = undefined
    }
  }

  /**
   * Get buffer size
   */
  getBufferSize(): number {
    return this.eventBuffer.length
  }

  /**
   * Get active playback count
   */
  getActiveCount(): number {
    return this.activePlaybacks.size
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up Proof-of-Play service')

    this.stopPeriodicFlush()

    // Flush remaining events
    if (this.eventBuffer.length > 0) {
      await this.flushEvents()
    }
  }

  /**
   * Normalize legacy PoP event shapes into the current API contract
   */
  private normalizeEvent(event: any): ProofOfPlayEvent {
    const pairingService = getPairingService()
    const durationMs = event.durationMs ?? event.duration_ms
    const normalizedDuration =
      typeof event.duration === 'number'
        ? event.duration
        : durationMs !== undefined
          ? Math.max(0, Math.round(Number(durationMs) / 1000))
          : 0

    return {
      device_id: event.device_id || event.deviceId || pairingService.getDeviceId() || '',
      schedule_id: event.schedule_id || event.scheduleId || '',
      media_id: event.media_id || event.mediaId || '',
      start_time: event.start_time || event.startTimestamp || event.start_timestamp || new Date().toISOString(),
      end_time: event.end_time || event.endTimestamp || event.end_timestamp || new Date().toISOString(),
      duration: normalizedDuration,
      completed: event.completed ?? true,
    }
  }
}

// Singleton instance
let popService: ProofOfPlayService | null = null

export function getProofOfPlayService(): ProofOfPlayService {
  if (!popService) {
    popService = new ProofOfPlayService()
  }
  return popService
}
