/**
 * Snapshot Manager - Fetches device snapshots, caches media, and builds playlists
 */

import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { CacheError, DeviceApiError, LayoutScene, PlaybackMode, TimelineItem } from '../../common/types'
import { atomicWrite, ensureDir } from '../../common/utils'
import { getHttpClient } from './network/http-client'
import { getPairingService } from './pairing-service'
import { getCacheManager } from './cache/cache-manager'
import { NormalizedSnapshot, parseSnapshotResponse } from './snapshot-parser'
import { getLifecycleEvents } from './lifecycle-events'
import { NormalizedScheduleWindow, evaluateScheduleWindows } from './snapshot-evaluator'

const logger = getLogger('snapshot-manager')

export interface PlaybackPlaylist {
  mode: PlaybackMode
  items: TimelineItem[]
  scheduleId?: string
  snapshotId?: string
  lastSnapshotAt?: string
}

type LayoutSlotSpec = {
  id?: string
  slot_id?: string
  x?: number | string
  y?: number | string
  w?: number | string
  h?: number | string
  width?: number | string
  height?: number | string
  zIndex?: number
  z_index?: number
}

export class SnapshotManager extends EventEmitter {
  private currentSnapshot?: NormalizedSnapshot
  private currentPlaylist?: PlaybackPlaylist
  private pollInterval?: NodeJS.Timeout
  private evaluationTimer?: NodeJS.Timeout
  private isPolling = false
  private snapshotPath: string
  private lastError?: string

  constructor() {
    super()
    const config = getConfigManager().getConfig()
    this.snapshotPath = path.join(config.cache.path, 'last-snapshot.json')
    ensureDir(path.dirname(this.snapshotPath), 0o755)
    this.loadCachedSnapshot()
  }

  start(): void {
    if (this.isPolling) {
      return
    }

    const config = getConfigManager().getConfig()
    const intervalMs = config.intervals.schedulePollMs

    this.isPolling = true
    this.refreshSnapshot().catch((error) => {
      logger.error({ error }, 'Initial snapshot fetch failed')
    })

    this.pollInterval = setInterval(() => {
      this.refreshSnapshot().catch((error) => {
        logger.error({ error }, 'Snapshot poll failed')
      })
    }, intervalMs)

    logger.info({ intervalMs }, 'Snapshot manager started')
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = undefined
    }
    if (this.evaluationTimer) {
      clearTimeout(this.evaluationTimer)
      this.evaluationTimer = undefined
    }
    this.isPolling = false
  }

  getCurrentPlaylist(): PlaybackPlaylist | undefined {
    return this.currentPlaylist
  }

  getLastSnapshotAt(): string | undefined {
    return this.currentPlaylist?.lastSnapshotAt
  }

  getLastError(): string | undefined {
    return this.lastError
  }

  async refreshSnapshot(retryOnExpired: boolean = true): Promise<PlaybackPlaylist | null> {
    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()

    if (!deviceId) {
      return null
    }

    try {
      const httpClient = getHttpClient()
      const response = await httpClient.getResponse(`/api/v1/device/${deviceId}/snapshot?include_urls=true`, {
        headers: this.currentSnapshot?.snapshotId
          ? {
              'If-None-Match': `"${this.currentSnapshot.snapshotId}"`,
            }
          : undefined,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
      })

      if (response.status === 304 && this.currentSnapshot) {
        logger.debug({ snapshotId: this.currentSnapshot.snapshotId }, 'Snapshot not modified, reusing cached payload')
        const playlist = await this.buildPlaylist(this.currentSnapshot, 'normal')
        this.currentPlaylist = playlist
        this.lastError = undefined
        this.emit('playlist-updated', playlist)
        return playlist
      }

      if (response.data && typeof response.data === 'object' && (response.data as any).success === false) {
        const message = (response.data as any)?.error?.message || 'Snapshot request failed'
        throw new Error(message)
      }

      const normalized = parseSnapshotResponse(response.data)
      await this.persistSnapshot(normalized)

      await this.cacheSnapshotMedia(normalized)
      const playlist = await this.buildPlaylist(normalized, 'normal')

      this.currentSnapshot = normalized
      this.currentPlaylist = playlist
      this.lastError = undefined

      this.emit('playlist-updated', playlist)
      return playlist
    } catch (error: any) {
      if (error instanceof DeviceApiError && (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')) {
        getLifecycleEvents().emitRuntimeAuthFailure({
          source: 'snapshot',
          error,
        })
      }

      const status = error?.response?.status

      if (status === 404) {
        logger.warn('Snapshot not found (404), using offline fallback if available')
        return this.applyOfflineFallback('No published snapshot available')
      }

      if (error instanceof CacheError && error.details?.['reason'] === 'URL_EXPIRED' && retryOnExpired) {
        logger.warn('Media URL expired, refetching snapshot')
        return await this.refreshSnapshot(false)
      }

      logger.error({ error }, 'Snapshot fetch failed, using offline fallback')
      return this.applyOfflineFallback((error as Error).message)
    }
  }

  private loadCachedSnapshot(): void {
    if (!fs.existsSync(this.snapshotPath)) {
      return
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf-8'))
      const normalized = parseSnapshotResponse(data)
      this.currentSnapshot = normalized
      this.buildPlaylist(normalized, 'offline').then((playlist) => {
        this.currentPlaylist = playlist
        this.emit('playlist-updated', playlist)
      })
      logger.info('Loaded cached snapshot for offline fallback')
    } catch (error) {
      logger.error({ error }, 'Failed to load cached snapshot')
    }
  }

  private async persistSnapshot(snapshot: NormalizedSnapshot): Promise<void> {
    const payload = snapshot.raw ?? snapshot
    await atomicWrite(this.snapshotPath, JSON.stringify(payload, null, 2))
  }

  private async cacheSnapshotMedia(snapshot: NormalizedSnapshot): Promise<void> {
    const cacheManager = getCacheManager()
    const allItems: TimelineItem[] = []

    allItems.push(...snapshot.items)
    snapshot.scheduleWindows.forEach((window) => {
      allItems.push(...window.items)
    })
    if (snapshot.emergencyItem) allItems.push(snapshot.emergencyItem)
    if (snapshot.defaultItem) allItems.push(snapshot.defaultItem)

    for (const item of allItems) {
      if (!item.mediaId || !item.remoteUrl) {
        continue
      }

      try {
        await cacheManager.add(item.mediaId, item.remoteUrl, item.sha256)
      } catch (error) {
        if (error instanceof CacheError && error.details?.['reason'] === 'URL_EXPIRED') {
          throw error
        }
        logger.warn({ mediaId: item.mediaId, error }, 'Failed to cache media item')
      }
    }
  }

  private async buildPlaylist(snapshot: NormalizedSnapshot, fallbackMode: PlaybackMode): Promise<PlaybackPlaylist> {
    let mode: PlaybackMode = 'normal'
    let items: TimelineItem[] = []
    let nextTransitionAt: number | undefined

    if (snapshot.emergencyItem) {
      mode = 'emergency'
      items = await this.attachLocalMedia([snapshot.emergencyItem])
      nextTransitionAt =
        snapshot.emergencyExpiresAt && Number.isFinite(Date.parse(snapshot.emergencyExpiresAt))
          ? Date.parse(snapshot.emergencyExpiresAt)
          : undefined
    } else if (snapshot.scheduleWindows.length > 0) {
      const evaluation = evaluateScheduleWindows(snapshot.scheduleWindows)
      nextTransitionAt = evaluation.nextTransitionAt

      if (evaluation.activeWindow && evaluation.items.length > 0) {
        mode = 'normal'
        const hydratedWindowItems = await this.attachLocalMedia(evaluation.items)
        items = this.buildLayoutSceneItems(evaluation.activeWindow, hydratedWindowItems)
      } else if (snapshot.defaultItem) {
        mode = 'default'
        items = await this.attachLocalMedia([snapshot.defaultItem])
      } else {
        mode = fallbackMode
        items = []
      }
    } else if (snapshot.items.length > 0) {
      mode = 'normal'
      items = await this.attachLocalMedia(snapshot.items)
    } else if (snapshot.defaultItem) {
      mode = 'default'
      items = await this.attachLocalMedia([snapshot.defaultItem])
    } else {
      mode = fallbackMode
      items = []
    }

    this.scheduleLocalEvaluation(snapshot, nextTransitionAt)

    return {
      mode,
      items,
      scheduleId: snapshot.scheduleId,
      snapshotId: snapshot.snapshotId,
      lastSnapshotAt: snapshot.fetchedAt,
    }
  }

  private scheduleLocalEvaluation(snapshot: NormalizedSnapshot, nextTransitionAt?: number): void {
    if (this.evaluationTimer) {
      clearTimeout(this.evaluationTimer)
      this.evaluationTimer = undefined
    }

    if (!nextTransitionAt || !Number.isFinite(nextTransitionAt)) {
      return
    }

    const delayMs = Math.max(250, nextTransitionAt - Date.now())
    this.evaluationTimer = setTimeout(() => {
      void this.rebuildFromCachedSnapshot(snapshot.snapshotId)
    }, delayMs)
  }

  private async rebuildFromCachedSnapshot(expectedSnapshotId?: string): Promise<void> {
    if (!this.currentSnapshot) {
      return
    }

    if (expectedSnapshotId && this.currentSnapshot.snapshotId && expectedSnapshotId !== this.currentSnapshot.snapshotId) {
      return
    }

    const playlist = await this.buildPlaylist(this.currentSnapshot, 'offline')
    this.currentPlaylist = playlist
    this.emit('playlist-updated', playlist)
  }

  private async attachLocalMedia(items: TimelineItem[]): Promise<TimelineItem[]> {
    const cacheManager = getCacheManager()

    const hydrated: TimelineItem[] = []
    for (const item of items) {
      const mediaId = item.mediaId || item.objectKey
      let localPath: string | undefined
      if (mediaId) {
        localPath = await cacheManager.get(mediaId)
      }

      if (!localPath) {
        logger.warn({ mediaId }, 'Media not cached, skipping item')
        continue
      }

       localPath = await this.normalizeLocalMediaPath(item, localPath)

      hydrated.push({
        ...item,
        localPath,
        localUrl: pathToFileURL(localPath).toString(),
      })
    }

    return hydrated
  }

  private async normalizeLocalMediaPath(item: TimelineItem, localPath: string): Promise<string> {
    if (item.type !== 'pdf') {
      return localPath
    }

    const sourceContentType =
      typeof item.meta?.['source_content_type'] === 'string' ? String(item.meta?.['source_content_type']) : undefined
    const alreadyPdf = /\.pdf$/i.test(localPath)
    if (alreadyPdf || sourceContentType !== 'application/pdf') {
      return localPath
    }

    const normalizedPath = `${localPath}.pdf`
    if (fs.existsSync(normalizedPath)) {
      return normalizedPath
    }

    try {
      await fs.promises.copyFile(localPath, normalizedPath)
      return normalizedPath
    } catch (error) {
      logger.warn({ localPath, normalizedPath, error }, 'Failed to create normalized PDF cache alias')
      return localPath
    }
  }

  private buildLayoutSceneItems(window: NormalizedScheduleWindow, items: TimelineItem[]): TimelineItem[] {
    const slots = this.extractLayoutSlots(window)
    if (slots.length === 0) {
      return items
    }

    const itemsBySlot = new Map<string, TimelineItem[]>()
    for (const item of items) {
      const slotId = typeof item.meta?.['slotId'] === 'string' ? String(item.meta?.['slotId']) : undefined
      if (!slotId) {
        return items
      }
      const bucket = itemsBySlot.get(slotId) || []
      bucket.push(item)
      itemsBySlot.set(slotId, bucket)
    }

    const sceneSlots = slots
      .map((slot) => {
        const slotId = slot.id || slot.slot_id
        if (!slotId) {
          return null
        }

        const slotItems = itemsBySlot.get(slotId) || []
        if (slotItems.length === 0) {
          return null
        }

        return {
          id: slotId,
          bounds: {
            x: slot.x ?? 0,
            y: slot.y ?? 0,
            w: slot.w ?? slot.width ?? 1,
            h: slot.h ?? slot.height ?? 1,
            zIndex: slot.zIndex ?? slot.z_index,
          },
          items: slotItems,
        }
      })
      .filter(Boolean) as LayoutScene['slots']

    if (sceneSlots.length === 0) {
      return items
    }

    const nowMs = Date.now()
    const endAtMs = window.endAt ? Date.parse(window.endAt) : Number.NaN
    const remainingMs = Number.isFinite(endAtMs) ? Math.max(1000, endAtMs - nowMs) : 10000
    const primaryMediaId = sceneSlots[0]?.items[0]?.mediaId

    const scene: LayoutScene = {
      layoutId: window.layout?.id,
      layoutName: window.layout?.name,
      aspectRatio: window.layout?.aspect_ratio,
      startsAt: window.startAt,
      endsAt: window.endAt,
      slots: sceneSlots,
    }

    return [
      {
        id: `scene:${window.id}`,
        type: 'scene',
        mediaId: primaryMediaId,
        displayMs: remainingMs,
        fit: 'contain',
        muted: true,
        transitionDurationMs: 0,
        meta: {
          source: 'schedule',
          presentationId: window.presentationId,
          presentationName: window.presentationName,
          layout: window.layout,
          scene,
        },
      },
    ]
  }

  private extractLayoutSlots(window: NormalizedScheduleWindow): LayoutSlotSpec[] {
    const spec = window.layout?.spec
    if (!spec || typeof spec !== 'object') {
      return []
    }

    const slots = (spec as { slots?: unknown[] }).slots
    return Array.isArray(slots) ? (slots as LayoutSlotSpec[]) : []
  }

  private async applyOfflineFallback(reason?: string): Promise<PlaybackPlaylist> {
    this.lastError = reason

    if (this.currentSnapshot) {
      const playlist = await this.buildPlaylist(this.currentSnapshot, 'offline')
      this.currentPlaylist = playlist
      this.emit('playlist-updated', playlist)
      return playlist
    }

    const playlist: PlaybackPlaylist = {
      mode: 'empty',
      items: [],
      lastSnapshotAt: this.currentPlaylist?.lastSnapshotAt,
    }
    this.currentPlaylist = playlist
    this.emit('playlist-updated', playlist)
    return playlist
  }
}

// Singleton instance
let snapshotManager: SnapshotManager | null = null

export function getSnapshotManager(): SnapshotManager {
  if (!snapshotManager) {
    snapshotManager = new SnapshotManager()
  }
  return snapshotManager
}
