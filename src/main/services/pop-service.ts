/**
 * Proof-of-Play Service - Track and report media playback events.
 * Features: bounded offline spooling, paced replay, deduplication, observable replay state.
 */

import * as fs from 'fs'
import * as path from 'path'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { DeviceApiError, ProofOfPlayEvent } from '../../common/types'
import { atomicWrite, ensureDir, generateId, sleep } from '../../common/utils'
import { getHttpClient } from './network/http-client'
import { getPairingService } from './pairing-service'
import { getLifecycleEvents } from './lifecycle-events'

const logger = getLogger('pop-service')

interface ActivePlayback {
  scheduleId: string
  mediaId: string
  startTimestamp: string
}

interface BufferedProofOfPlayEvent extends ProofOfPlayEvent {
  source: 'live' | 'spool'
}

export interface ProofOfPlayReplayStats {
  bufferItems: number
  bufferBytes: number
  spoolFiles: number
  spoolBytes: number
  droppedEvents: number
  droppedBytes: number
  compactedEvents: number
  compactedBytes: number
  lastDropReason?: string
  lastDropAt?: string
  lastCompactionReason?: string
  lastCompactionAt?: string
}

interface SpoolFileEntry {
  filePath: string
  fileName: string
  sizeBytes: number
  mtimeMs: number
}

const MAX_BUFFER_EVENTS = 100
const MAX_BUFFER_BYTES = 512 * 1024
const MAX_SPOOL_FILES = 32
const MAX_SPOOL_BYTES_MIN = 1024 * 1024
const MAX_SPOOL_BYTES_MAX = 16 * 1024 * 1024
const MAX_SPOOL_EVENTS_PER_FILE = 50
const MAX_REPLAY_BATCH_SIZE = 25
const IDLE_FLUSH_MS = 60000
const BACKLOG_FLUSH_MS = 15000

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function stripReplayMetadata(event: BufferedProofOfPlayEvent | ProofOfPlayEvent): ProofOfPlayEvent {
  return {
    device_id: event.device_id,
    schedule_id: event.schedule_id,
    media_id: event.media_id,
    start_time: event.start_time,
    end_time: event.end_time,
    duration: event.duration,
    completed: event.completed,
  }
}

export class ProofOfPlayService {
  private readonly spoolPath: string
  private readonly statePath: string
  private readonly maxSpoolBytes: number
  private activePlaybacks: Map<string, ActivePlayback>
  private eventBuffer: BufferedProofOfPlayEvent[]
  private flushTimer?: NodeJS.Timeout
  private isFlushing = false
  private seenEvents: Set<string>
  private stats: ProofOfPlayReplayStats = {
    bufferItems: 0,
    bufferBytes: 0,
    spoolFiles: 0,
    spoolBytes: 0,
    droppedEvents: 0,
    droppedBytes: 0,
    compactedEvents: 0,
    compactedBytes: 0,
  }

  constructor() {
    const config = getConfigManager().getConfig()
    this.spoolPath = path.join(config.cache.path, 'pop-spool')
    this.statePath = path.join(config.cache.path, 'pop-spool-state.json')
    this.maxSpoolBytes = clamp(Math.round(config.cache.maxBytes * 0.02), MAX_SPOOL_BYTES_MIN, MAX_SPOOL_BYTES_MAX)
    ensureDir(this.spoolPath, 0o755)

    this.activePlaybacks = new Map()
    this.eventBuffer = []
    this.seenEvents = new Set()

    this.loadState()
    this.restoreInflightFiles()
    this.refreshStats()
    this.startPeriodicFlush()

    logger.info(
      {
        spoolPath: this.spoolPath,
        maxSpoolBytes: this.maxSpoolBytes,
      },
      'Proof-of-Play service initialized'
    )
  }

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

    const event: BufferedProofOfPlayEvent = {
      source: 'live',
      device_id: deviceId,
      schedule_id: scheduleId,
      media_id: mediaId,
      start_time: active.startTimestamp,
      end_time: endTimestamp,
      duration: durationSeconds,
      completed,
    }

    if (!this.isDuplicate(event)) {
      this.eventBuffer.push(event)
      this.trimLiveBuffer().catch((error) => {
        logger.error({ error }, 'Failed to trim PoP buffer')
      })
      logger.debug({ scheduleId, mediaId, durationSeconds, completed }, 'Playback ended')

      if (this.eventBuffer.length >= MAX_BUFFER_EVENTS) {
        this.flushEvents().catch((error) => {
          logger.error({ error }, 'Failed to flush events')
        })
      }
    } else {
      logger.debug({ scheduleId, mediaId }, 'Duplicate event detected, skipping')
    }

    this.activePlaybacks.delete(key)
  }

  private isDuplicate(event: ProofOfPlayEvent): boolean {
    const key = `${event.device_id}:${event.media_id}:${event.start_time}`
    if (this.seenEvents.has(key)) {
      return true
    }
    this.seenEvents.add(key)

    if (this.seenEvents.size > 10000) {
      const entries = Array.from(this.seenEvents)
      this.seenEvents = new Set(entries.slice(5000))
    }

    return false
  }

  private estimateEventSize(event: ProofOfPlayEvent): number {
    return Buffer.byteLength(JSON.stringify(stripReplayMetadata(event)), 'utf8')
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) {
        return
      }

      const data = fs.readFileSync(this.statePath, 'utf8')
      const parsed = JSON.parse(data) as Partial<ProofOfPlayReplayStats>
      this.stats = {
        bufferItems: 0,
        bufferBytes: 0,
        spoolFiles: 0,
        spoolBytes: 0,
        droppedEvents: parsed.droppedEvents ?? 0,
        droppedBytes: parsed.droppedBytes ?? 0,
        compactedEvents: parsed.compactedEvents ?? 0,
        compactedBytes: parsed.compactedBytes ?? 0,
        lastDropReason: parsed.lastDropReason,
        lastDropAt: parsed.lastDropAt,
        lastCompactionReason: parsed.lastCompactionReason,
        lastCompactionAt: parsed.lastCompactionAt,
      }
    } catch (error) {
      logger.error({ error }, 'Failed to load PoP replay state')
    }
  }

  private async persistState(): Promise<void> {
    try {
      await atomicWrite(this.statePath, JSON.stringify(this.stats, null, 2))
    } catch (error) {
      logger.error({ error }, 'Failed to persist PoP replay state')
    }
  }

  private listSpoolFiles(prefix: 'pop-' | 'inflight-' | 'all' = 'pop-'): SpoolFileEntry[] {
    if (!fs.existsSync(this.spoolPath)) {
      return []
    }

    return fs
      .readdirSync(this.spoolPath)
      .filter((fileName) => {
        if (prefix === 'all') {
          return (
            (fileName.startsWith('pop-') || fileName.startsWith('inflight-')) &&
            fileName.endsWith('.json')
          )
        }
        return fileName.startsWith(prefix) && fileName.endsWith('.json')
      })
      .map((fileName) => {
        const filePath = path.join(this.spoolPath, fileName)
        const stats = fs.statSync(filePath)
        return {
          filePath,
          fileName,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
        }
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs)
  }

  private refreshStats(): void {
    this.stats.bufferItems = this.eventBuffer.length
    this.stats.bufferBytes = this.eventBuffer.reduce((total, event) => total + this.estimateEventSize(event), 0)

    const spoolFiles = this.listSpoolFiles('all')
    this.stats.spoolFiles = spoolFiles.length
    this.stats.spoolBytes = spoolFiles.reduce((total, file) => total + file.sizeBytes, 0)
  }

  private recordReplayDiscard(
    events: Array<BufferedProofOfPlayEvent | ProofOfPlayEvent>,
    action: 'dropped' | 'compacted',
    reason: string
  ): void {
    const eventCount = events.length
    const bytes = events.reduce((total, event) => total + this.estimateEventSize(event), 0)
    const now = new Date().toISOString()

    if (action === 'dropped') {
      this.stats.droppedEvents += eventCount
      this.stats.droppedBytes += bytes
      this.stats.lastDropReason = reason
      this.stats.lastDropAt = now
    } else {
      this.stats.compactedEvents += eventCount
      this.stats.compactedBytes += bytes
      this.stats.lastCompactionReason = reason
      this.stats.lastCompactionAt = now
    }

    logger.warn({ eventCount, bytes, action, reason }, 'Adjusted PoP replay backlog')
  }

  private restoreInflightFiles(): void {
    for (const file of this.listSpoolFiles('inflight-')) {
      const targetPath = path.join(this.spoolPath, file.fileName.replace(/^inflight-/, 'pop-'))
      try {
        fs.renameSync(file.filePath, targetPath)
      } catch (error) {
        logger.warn({ error, file: file.fileName }, 'Failed to restore inflight PoP spool file')
      }
    }
  }

  private async trimLiveBuffer(): Promise<void> {
    let overflowEvents: BufferedProofOfPlayEvent[] = []
    let bufferBytes = this.eventBuffer.reduce((total, event) => total + this.estimateEventSize(event), 0)

    while (this.eventBuffer.length > MAX_BUFFER_EVENTS || bufferBytes > MAX_BUFFER_BYTES) {
      const removed = this.eventBuffer.shift()
      if (!removed) {
        break
      }
      overflowEvents.push(removed)
      bufferBytes -= this.estimateEventSize(removed)
    }

    if (overflowEvents.length > 0) {
      await this.spoolEvents(overflowEvents.map((event) => stripReplayMetadata(event)), 'buffer-overflow')
      this.recordReplayDiscard(overflowEvents, 'compacted', 'buffer-overflow')
    }

    this.refreshStats()
    await this.persistState()
  }

  private async spoolEvents(events: ProofOfPlayEvent[], reason: string): Promise<void> {
    if (events.length === 0) {
      return
    }

    const chunks: ProofOfPlayEvent[][] = []
    for (let index = 0; index < events.length; index += MAX_SPOOL_EVENTS_PER_FILE) {
      chunks.push(events.slice(index, index + MAX_SPOOL_EVENTS_PER_FILE))
    }

    for (const chunk of chunks) {
      const spoolFile = path.join(this.spoolPath, `pop-${Date.now()}-${generateId(8)}.json`)
      try {
        await atomicWrite(spoolFile, JSON.stringify(chunk, null, 2))
        logger.info({ spoolFile, count: chunk.length, reason }, 'PoP events spooled to disk')
      } catch (error) {
        logger.error({ error, spoolFile, count: chunk.length, reason }, 'Failed to spool PoP events')
      }
    }

    await this.enforceSpoolBudget()
    this.refreshStats()
    await this.persistState()
  }

  private async enforceSpoolBudget(): Promise<void> {
    const files = this.listSpoolFiles('pop-')
    let totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0)
    let remainingFiles = [...files]

    while (remainingFiles.length > MAX_SPOOL_FILES || totalBytes > this.maxSpoolBytes) {
      const oldest = remainingFiles.shift()
      if (!oldest) {
        break
      }

      try {
        const content = fs.readFileSync(oldest.filePath, 'utf8')
        const events = JSON.parse(content) as ProofOfPlayEvent[]
        fs.unlinkSync(oldest.filePath)
        totalBytes -= oldest.sizeBytes
        this.recordReplayDiscard(events, 'dropped', 'spool-budget-exceeded')
      } catch (error) {
        logger.error({ error, file: oldest.fileName }, 'Failed to enforce PoP spool budget')
        break
      }
    }
  }

  private async loadSpoolBatch(maxEvents: number): Promise<{ files: string[]; events: BufferedProofOfPlayEvent[] }> {
    const filesToReplay = this.listSpoolFiles('pop-')
    const claimedFiles: string[] = []
    const events: BufferedProofOfPlayEvent[] = []

    for (const file of filesToReplay) {
      if (events.length >= maxEvents) {
        break
      }

      const inflightPath = path.join(this.spoolPath, file.fileName.replace(/^pop-/, 'inflight-'))
      try {
        fs.renameSync(file.filePath, inflightPath)
        const data = fs.readFileSync(inflightPath, 'utf8')
        const parsed = JSON.parse(data) as ProofOfPlayEvent[]
        const normalized = parsed
          .map((event) => this.normalizeEvent(event))
          .filter(Boolean)
          .map((event) => ({ ...event, source: 'spool' as const }))

        if (normalized.length === 0) {
          fs.unlinkSync(inflightPath)
          continue
        }

        const remainingCapacity = maxEvents - events.length
        if (normalized.length > remainingCapacity) {
          const replayable = normalized.slice(0, remainingCapacity)
          const leftover = normalized.slice(remainingCapacity)
          const remainderPath = path.join(this.spoolPath, `pop-${Date.now()}-${generateId(8)}.json`)
          await atomicWrite(
            remainderPath,
            JSON.stringify(leftover.map((event) => stripReplayMetadata(event)), null, 2)
          )
          events.push(...replayable)
        } else {
          events.push(...normalized)
        }
        claimedFiles.push(inflightPath)
      } catch (error) {
        logger.error({ error, file: file.fileName }, 'Failed to load PoP spool file for replay')
      }
    }

    return { files: claimedFiles, events }
  }

  async flushEvents(): Promise<void> {
    if (this.isFlushing) {
      logger.debug('Already flushing events')
      return
    }

    const spoolBacklog = this.listSpoolFiles('pop-').length
    if (this.eventBuffer.length === 0 && spoolBacklog === 0) {
      this.scheduleNextFlush()
      return
    }

    this.isFlushing = true
    logger.info({ buffer: this.eventBuffer.length, spoolFiles: spoolBacklog }, 'Flushing PoP events')

    try {
      const pairingService = getPairingService()
      const deviceId = pairingService.getDeviceId()

      if (!deviceId) {
        const liveEvents = this.eventBuffer.splice(0)
        if (liveEvents.length > 0) {
          await this.spoolEvents(liveEvents.map((event) => stripReplayMetadata(event)), 'missing-device-id')
        }
        this.refreshStats()
        return
      }

      const liveBatch = this.eventBuffer.splice(0, MAX_REPLAY_BATCH_SIZE)
      const spoolBatch = await this.loadSpoolBatch(MAX_REPLAY_BATCH_SIZE - liveBatch.length)
      const replayBatch = [...liveBatch, ...spoolBatch.events]
      if (replayBatch.length === 0) {
        return
      }

      const httpClient = getHttpClient()
      const failedEvents: BufferedProofOfPlayEvent[] = []

      for (const event of replayBatch) {
        try {
          const payload: ProofOfPlayEvent = {
            ...stripReplayMetadata(event),
            device_id: event.device_id || deviceId,
          }
          await httpClient.post('/api/v1/device/proof-of-play', payload, {
            retryPolicy: {
              maxAttempts: 3,
              baseDelayMs: 2000,
              maxDelayMs: 30000,
            },
          })
        } catch (error) {
          if (
            error instanceof DeviceApiError &&
            (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
          ) {
            getLifecycleEvents().emitRuntimeAuthFailure({
              source: 'proof-of-play',
              error,
            })
          }
          logger.warn({ error, event }, 'Failed to flush PoP event')
          failedEvents.push(event)
        }

        await sleep(50 + Math.floor(Math.random() * 151))
      }

      if (failedEvents.length > 0) {
        await this.spoolEvents(failedEvents.map((event) => stripReplayMetadata(event)), 'replay-failure')
      }

      for (const inflightFile of spoolBatch.files) {
        try {
          fs.unlinkSync(inflightFile)
        } catch (error) {
          logger.warn({ error, inflightFile }, 'Failed to clean up inflight PoP file')
        }
      }

      this.refreshStats()
      await this.persistState()
      logger.info(
        {
          replayed: replayBatch.length,
          failed: failedEvents.length,
          remainingBuffer: this.eventBuffer.length,
          remainingSpoolFiles: this.listSpoolFiles('pop-').length,
        },
        'PoP replay cycle completed'
      )
    } finally {
      this.isFlushing = false
      this.scheduleNextFlush()
    }
  }

  private computeNextFlushDelay(): number {
    const hasBacklog = this.eventBuffer.length > 0 || this.listSpoolFiles('pop-').length > 0
    if (!hasBacklog) {
      return IDLE_FLUSH_MS - 5000 + Math.floor(Math.random() * 10001)
    }
    return BACKLOG_FLUSH_MS - 3000 + Math.floor(Math.random() * 6001)
  }

  private scheduleNextFlush(delayMs?: number): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
    }
    const delay = typeof delayMs === 'number' ? Math.max(1000, delayMs) : this.computeNextFlushDelay()
    this.flushTimer = setTimeout(() => {
      this.flushEvents().catch((error) => {
        logger.error({ error }, 'Periodic flush failed')
      })
    }, delay)
  }

  private startPeriodicFlush(): void {
    this.scheduleNextFlush(this.eventBuffer.length > 0 || this.listSpoolFiles('pop-').length > 0 ? 3000 : undefined)
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  getBufferSize(): number {
    return this.eventBuffer.length
  }

  getActiveCount(): number {
    return this.activePlaybacks.size
  }

  getReplayStats(): ProofOfPlayReplayStats {
    this.refreshStats()
    return JSON.parse(JSON.stringify(this.stats))
  }

  async cleanup(): Promise<void> {
    logger.info('Cleaning up Proof-of-Play service')
    this.stopPeriodicFlush()

    if (this.eventBuffer.length > 0 || this.listSpoolFiles('pop-').length > 0) {
      await this.flushEvents()
    }
  }

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

let popService: ProofOfPlayService | null = null

export function getProofOfPlayService(): ProofOfPlayService {
  if (!popService) {
    popService = new ProofOfPlayService()
  }
  return popService
}
