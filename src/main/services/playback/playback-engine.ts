/**
 * Playback Engine - Main orchestrator for media playback
 * Coordinates timeline scheduling, media rendering, and transitions
 */

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

export class PlaybackEngine extends EventEmitter {
  private state: PlaybackState = 'stopped'
  private scheduler: TimelineScheduler
  private mainWindow?: BrowserWindow
  private currentItem?: TimelineItem
  private currentScheduleId?: string
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
    this.currentItem = undefined

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

    logger.info(
      {
        itemId: item.id,
        type: item.type,
        displayMs: item.displayMs,
      },
      'Playing item'
    )

    // Mark as now-playing in cache
    const mediaId = item.mediaId || item.objectKey
    if (mediaId) {
      const cacheManager = getCacheManager()
      cacheManager.markNowPlaying(mediaId)
    }

    // Record proof-of-play start
    if (this.currentScheduleId) {
      const popService = getProofOfPlayService()
      popService.recordStart(this.currentScheduleId, item.mediaId || item.id)
    }

    // Update telemetry
    const telemetryService = getTelemetryService()
    telemetryService.setCurrentMedia(item.mediaId || item.id)

    // Send to renderer
    if (this.mainWindow) {
      this.mainWindow.webContents.send('media-change', {
        item,
        scheduledItem,
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
    const mediaId = item.mediaId || item.objectKey
    if (mediaId) {
      const cacheManager = getCacheManager()
      cacheManager.unmarkNowPlaying(mediaId)
    }

    // Record proof-of-play end
    if (this.currentScheduleId) {
      const popService = getProofOfPlayService()
      popService.recordEnd(this.currentScheduleId, item.mediaId || item.id, true)
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
}

// Singleton instance
let playbackEngine: PlaybackEngine | null = null

export function getPlaybackEngine(): PlaybackEngine {
  if (!playbackEngine) {
    playbackEngine = new PlaybackEngine()
  }
  return playbackEngine
}
