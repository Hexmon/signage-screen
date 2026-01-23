/**
 * Snapshot Manager - Fetches device snapshots, caches media, and builds playlists
 */

import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { CacheError, PlaybackMode, TimelineItem } from '../../common/types'
import { atomicWrite, ensureDir } from '../../common/utils'
import { getHttpClient } from './network/http-client'
import { getPairingService } from './pairing-service'
import { getCacheManager } from './cache/cache-manager'
import { NormalizedSnapshot, parseSnapshotResponse } from './snapshot-parser'

const logger = getLogger('snapshot-manager')

export interface PlaybackPlaylist {
  mode: PlaybackMode
  items: TimelineItem[]
  scheduleId?: string
  snapshotId?: string
  lastSnapshotAt?: string
}

export class SnapshotManager extends EventEmitter {
  private currentSnapshot?: NormalizedSnapshot
  private currentPlaylist?: PlaybackPlaylist
  private pollInterval?: NodeJS.Timeout
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
      const response = await httpClient.get(`/api/v1/device/${deviceId}/snapshot?include_urls=true`)

      if (response && typeof response === 'object' && (response as any).success === false) {
        const message = (response as any)?.error?.message || 'Snapshot request failed'
        throw new Error(message)
      }

      const normalized = parseSnapshotResponse(response)
      await this.persistSnapshot(normalized)

      await this.cacheSnapshotMedia(normalized)
      const playlist = await this.buildPlaylist(normalized, 'normal')

      this.currentSnapshot = normalized
      this.currentPlaylist = playlist
      this.lastError = undefined

      this.emit('playlist-updated', playlist)
      return playlist
    } catch (error: any) {
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

    if (snapshot.emergencyItem) {
      mode = 'emergency'
      items = [snapshot.emergencyItem]
    } else if (snapshot.items.length > 0) {
      mode = 'normal'
      items = snapshot.items
    } else if (snapshot.defaultItem) {
      mode = 'default'
      items = [snapshot.defaultItem]
    } else {
      mode = fallbackMode
      items = []
    }

    const hydrated = await this.attachLocalMedia(items)

    return {
      mode,
      items: hydrated,
      scheduleId: snapshot.scheduleId,
      snapshotId: snapshot.snapshotId,
      lastSnapshotAt: snapshot.fetchedAt,
    }
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

      hydrated.push({
        ...item,
        localPath,
        localUrl: pathToFileURL(localPath).toString(),
      })
    }

    return hydrated
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
