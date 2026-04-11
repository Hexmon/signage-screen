/**
 * Playback Engine - Main orchestrator for media playback
 * Coordinates timeline scheduling, media rendering, and transitions
 */

import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import { getLogger } from '../../../common/logger'
import { PlaybackError, TimelineItem } from '../../../common/types'
import { getCacheManager } from '../cache/cache-manager'
import { getProofOfPlayService } from '../pop-service'
import { getTelemetryService } from '../telemetry/telemetry-service'
import { TimelineScheduler, ScheduledItem } from './timeline-scheduler'
import { getSnapshotManager, PlaybackPlaylist } from '../snapshot-manager'

const logger = getLogger('playback-engine')

export type PlaybackState = 'stopped' | 'playing' | 'paused' | 'error' | 'emergency'

function usesTimelinePlayback(playlist: PlaybackPlaylist): boolean {
  return playlist.mode === 'normal' || playlist.mode === 'emergency'
}

export class PlaybackEngine extends EventEmitter {
  private state: PlaybackState = 'stopped'
  private scheduler: TimelineScheduler
  private mainWindow?: BrowserWindow
  private currentItem?: TimelineItem
  private currentScheduleId?: string
  private currentTimelineFingerprint?: string
  private currentPlaybackInstanceId?: string
  private errorCount = 0
  private maxErrors = 5

  constructor() {
    super()
    this.scheduler = new TimelineScheduler()
    this.setupSchedulerListeners()
    this.setupSnapshotManagerListeners()
  }

  /**
   * Initialize playback engine with main window
   */
  initialize(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    logger.info('Playback engine initialized')
  }

  /**
   * Start playback
   */
  async start(): Promise<void> {
    if (this.state === 'playing') {
      logger.warn('Playback already started')
      return
    }

    logger.info('Starting playback')

    try {
      const snapshotManager = getSnapshotManager()
      const playlist = snapshotManager.getCurrentPlaylist()

      if (!playlist || playlist.items.length === 0) {
        throw new Error('No playlist available')
      }

      if (!usesTimelinePlayback(playlist)) {
        logger.info({ mode: playlist.mode }, 'Skipping timeline playback for non-scheduled playlist')
        this.stop()
        return
      }

      await this.startPlaylist(playlist)

      this.emit('playback-started')
      logger.info({ scheduleId: playlist.scheduleId, itemCount: playlist.items.length }, 'Playback started')
    } catch (error) {
      logger.error({ error }, 'Failed to start playback')
      this.state = 'error'
      this.handleError(error as Error)
      throw error
    }
  }

  /**
   * Stop playback
   */
  stop(): void {
    logger.info('Stopping playback')

    this.scheduler.stop()
    this.state = 'stopped'
    if (this.currentPlaybackInstanceId) {
      const popService = getProofOfPlayService()
      popService.recordEnd(this.currentPlaybackInstanceId, false)
      this.currentPlaybackInstanceId = undefined
    }
    this.currentItem = undefined
    this.currentScheduleId = undefined
    this.currentTimelineFingerprint = undefined

    const telemetryService = getTelemetryService()
    telemetryService.clearCurrentPlayback()

    if (this.mainWindow) {
      this.mainWindow.webContents.send('playback-update', {
        type: 'clear-active',
        reason: 'timeline-stopped',
      })
    }

    this.emit('playback-stopped')
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (this.state !== 'playing') {
      return
    }

    logger.info('Pausing playback')

    this.scheduler.pause()
    this.state = 'paused'

    this.emit('playback-paused')
  }

  /**
   * Resume playback
   */
  resume(): void {
    if (this.state !== 'paused') {
      return
    }

    logger.info('Resuming playback')

    this.scheduler.resume()
    this.state = 'playing'

    this.emit('playback-resumed')
  }

  /**
   * Handle emergency override
   */
  private async startPlaylist(playlist: PlaybackPlaylist): Promise<void> {
    this.currentScheduleId = playlist.scheduleId || playlist.snapshotId
    this.scheduler.stop()

    if (playlist.items.length === 0) {
      throw new Error('Playlist is empty')
    }

    this.state = playlist.mode === 'emergency' ? 'emergency' : 'playing'
    this.currentTimelineFingerprint = this.fingerprintPlaylist(playlist)
    this.scheduler.start(playlist.items)

    const telemetryService = getTelemetryService()
    if (this.currentScheduleId) {
      telemetryService.setCurrentSchedule(this.currentScheduleId)
    }
  }

  /**
   * Setup scheduler listeners
   */
  private setupSchedulerListeners(): void {
    this.scheduler.on('play-item', (scheduledItem: ScheduledItem) => {
      this.handlePlayItem(scheduledItem).catch((error) => {
        logger.error({ error, itemId: scheduledItem.item.id }, 'Failed to play item')
        this.handleError(error as Error)
      })
    })

    this.scheduler.on('item-complete', (scheduledItem: ScheduledItem) => {
      this.handleItemComplete(scheduledItem)
    })

    this.scheduler.on('transition-start', (current: ScheduledItem, next?: ScheduledItem) => {
      this.handleTransitionStart(current, next)
    })

    this.scheduler.on('timeline-complete', () => {
      logger.debug('Timeline completed, will loop')
    })
  }

  /**
   * Setup schedule manager listeners
   */
  private setupSnapshotManagerListeners(): void {
    const snapshotManager = getSnapshotManager()

    snapshotManager.on('playlist-updated', (playlist: PlaybackPlaylist) => {
      if (!usesTimelinePlayback(playlist)) {
        logger.info({ mode: playlist.mode }, 'Playlist updated for fallback mode, stopping timeline playback')
        this.stop()
        return
      }

      const nextFingerprint = this.fingerprintPlaylist(playlist)
      if (this.state !== 'stopped' && this.currentTimelineFingerprint === nextFingerprint) {
        logger.debug({ mode: playlist.mode }, 'Ignoring equivalent timeline playlist update')
        return
      }

      logger.info({ mode: playlist.mode }, 'Playlist updated, restarting playback')
      this.stop()
      this.startPlaylist(playlist).catch((error) => {
        logger.error({ error }, 'Failed to start playback for updated playlist')
      })
    })
  }

  /**
   * Handle play item
   */
  private async handlePlayItem(scheduledItem: ScheduledItem): Promise<void> {
    const item = scheduledItem.item
    this.currentItem = item
    this.currentPlaybackInstanceId = undefined

    logger.info(
      {
        itemId: item.id,
        type: item.type,
        displayMs: item.displayMs,
      },
      'Playing item'
    )

    // Mark as now-playing in cache
    const mediaId = item.mediaId || item.objectKey || item.id
    if (item.type !== 'scene' && mediaId) {
      const cacheManager = getCacheManager()
      cacheManager.markNowPlaying(mediaId)
    }

    // Record proof-of-play start
    if (this.currentScheduleId && item.type !== 'scene') {
      const popService = getProofOfPlayService()
      this.currentPlaybackInstanceId = randomUUID()
      popService.recordStart({
        scheduleId: this.currentScheduleId,
        mediaId,
        playbackInstanceId: this.currentPlaybackInstanceId,
        itemId: item.id,
        startedAt: new Date(scheduledItem.startTime).toISOString(),
      })
    }

    // Update telemetry
    const telemetryService = getTelemetryService()
    if (item.type === 'scene') {
      telemetryService.setActivePlayback(item.id, [])
    } else {
      telemetryService.setCurrentMedia(mediaId)
    }

    // Send to renderer
    if (this.mainWindow) {
      this.mainWindow.webContents.send('media-change', {
        item,
        scheduledItem,
        scheduleId: this.currentScheduleId,
      })
    }

    this.emit('item-playing', item)
  }

  /**
   * Handle item complete
   */
  private handleItemComplete(scheduledItem: ScheduledItem): void {
    const item = scheduledItem.item

    logger.debug({ itemId: item.id }, 'Item completed')

    // Unmark as now-playing in cache
    const mediaId = item.mediaId || item.objectKey || item.id
    if (item.type !== 'scene' && mediaId) {
      const cacheManager = getCacheManager()
      cacheManager.unmarkNowPlaying(mediaId)
    }

    // Record proof-of-play end
    if (this.currentPlaybackInstanceId && item.type !== 'scene') {
      const popService = getProofOfPlayService()
      popService.recordEnd(this.currentPlaybackInstanceId, true)
      this.currentPlaybackInstanceId = undefined
    }

    this.emit('item-completed', item)
  }

  /**
   * Handle transition start
   */
  private handleTransitionStart(current: ScheduledItem, next?: ScheduledItem): void {
    logger.debug(
      {
        currentId: current.item.id,
        nextId: next?.item.id,
      },
      'Transition starting'
    )

    if (this.mainWindow && next) {
      this.mainWindow.webContents.send('playback-update', {
        type: 'transition-start',
        current: current.item,
        next: next.item,
        scheduleId: this.currentScheduleId,
        durationMs: current.item.transitionDurationMs || 0,
      })
    }

    this.emit('transition-start', current.item, next?.item)
  }

  /**
   * Handle playback error
   */
  private handleError(error: Error): void {
    this.errorCount++

    logger.error({ error, errorCount: this.errorCount }, 'Playback error')

    const telemetryService = getTelemetryService()
    telemetryService.reportError(error.message)

    if (this.errorCount >= this.maxErrors) {
      logger.error('Max errors reached, stopping playback')
      this.stop()
      this.state = 'error'
      this.emit('playback-error', new PlaybackError('Max errors reached', { error: error.message }))
    } else {
      // Show fallback slide
      if (this.mainWindow) {
        this.mainWindow.webContents.send('playback-update', {
          type: 'show-fallback',
          message: error.message,
        })
      }
    }
  }

  /**
   * Get current state
   */
  getState(): PlaybackState {
    return this.state
  }

  /**
   * Get current item
   */
  getCurrentItem(): TimelineItem | undefined {
    return this.currentItem
  }

  /**
   * Get jitter statistics
   */
  getJitterStats() {
    return this.scheduler.getJitterStats()
  }

  private fingerprintPlaylist(playlist: PlaybackPlaylist): string {
    return JSON.stringify({
      mode: playlist.mode,
      scheduleId: playlist.scheduleId ?? null,
      items: playlist.items.map((item) => this.fingerprintTimelineItem(item)),
    })
  }

  private fingerprintTimelineItem(item: TimelineItem): unknown {
    const liveUrl = item.remoteUrl ?? item.url

    return {
      id: item.id,
      type: item.type,
      mediaId: item.mediaId ?? null,
      objectKey: item.objectKey ?? null,
      displayMs: item.displayMs,
      fit: item.fit,
      muted: item.muted,
      loop: item.loop,
      sha256: item.sha256 ?? null,
      transitionDurationMs: item.transitionDurationMs,
      remoteUrl: item.type === 'url'
        ? this.normalizeComparableUrl(liveUrl, true)
        : this.normalizeComparableUrl(liveUrl, false),
      meta: this.normalizeComparableMeta(item.meta),
    }
  }

  private normalizeComparableMeta(value: unknown, key?: string): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.normalizeComparableMeta(entry))
    }

    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && key) {
        if (key === 'source_url') {
          return this.normalizeComparableUrl(value, true)
        }

        if (
          key === 'media_url' ||
          key === 'fallback_url' ||
          key === 'fallback_media_url' ||
          key === 'remoteUrl' ||
          key === 'localUrl' ||
          key === 'fallback_local_url' ||
          key === 'url'
        ) {
          return this.normalizeComparableUrl(value, false)
        }
      }

      return value
    }

    const record = value as Record<string, unknown>

    if (record['type'] === 'url') {
      return {
        ...Object.keys(record)
          .sort()
          .reduce<Record<string, unknown>>((acc, currentKey) => {
            const currentValue = record[currentKey]
            if (currentKey === 'remoteUrl' || currentKey === 'url' || currentKey === 'source_url') {
              acc[currentKey] =
                typeof currentValue === 'string'
                  ? this.normalizeComparableUrl(currentValue, true)
                  : this.normalizeComparableMeta(currentValue, currentKey)
              return acc
            }

            acc[currentKey] = this.normalizeComparableMeta(currentValue, currentKey)
            return acc
          }, {}),
      }
    }

    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, currentKey) => {
        acc[currentKey] = this.normalizeComparableMeta(record[currentKey], currentKey)
        return acc
      }, {})
  }

  private normalizeComparableUrl(value?: string, preserveQuery: boolean = false): string | null {
    if (!value) {
      return null
    }

    try {
      const parsed = new URL(value)
      parsed.hash = ''
      if (!preserveQuery) {
        parsed.search = ''
      }
      return parsed.toString()
    } catch {
      return value
    }
  }
}

// Singleton instance
let playbackEngine: PlaybackEngine | null = null

export function getPlaybackEngine(): PlaybackEngine {
  if (!playbackEngine) {
    playbackEngine = new PlaybackEngine()
  }
  return playbackEngine
}
