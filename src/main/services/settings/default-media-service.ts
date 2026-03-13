/**
 * Default Media Service - Poll the backend for the resolved device fallback media
 */

import { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { getLogger } from '../../../common/logger'
import { getConfigManager } from '../../../common/config'
import { DefaultMediaResponse } from '../../../common/types'
import { atomicWrite, ensureDir } from '../../../common/utils'
import { getCacheManager } from '../cache/cache-manager'
import { getPairingService } from '../pairing-service'
import { getSettingsClient, normalizeDefaultMediaResponse } from './settings-client'

const logger = getLogger('default-media-service')

export class DefaultMediaService extends EventEmitter {
  private mainWindow?: BrowserWindow
  private pollInterval?: NodeJS.Timeout
  private current: DefaultMediaResponse = { source: 'NONE', aspect_ratio: null, media_id: null, media: null }
  private cachePath: string
  private isRunning = false
  private refreshPromise?: Promise<DefaultMediaResponse>

  constructor() {
    super()
    const config = getConfigManager().getConfig()
    this.cachePath = path.join(config.cache.path, 'default-media.json')
    ensureDir(path.dirname(this.cachePath), 0o755)
    void this.loadCached()
  }

  initialize(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    logger.info('Default media service initialized')
  }

  start(): void {
    if (this.isRunning) {
      return
    }

    const intervalMs = getConfigManager().getConfig().intervals.defaultMediaPollMs || 300000
    this.isRunning = true

    this.refreshNow('startup').catch((error) => {
      logger.warn({ error }, 'Initial default media fetch failed')
    })

    this.pollInterval = setInterval(() => {
      this.refreshNow('poll').catch((error) => {
        logger.warn({ error }, 'Default media poll failed')
      })
    }, intervalMs)

    logger.info({ intervalMs }, 'Default media polling started')
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = undefined
    }
    this.isRunning = false
  }

  getCurrent(): DefaultMediaResponse {
    return this.current
  }

  async getDefaultMedia(options: { refresh?: boolean } = {}): Promise<DefaultMediaResponse> {
    if (options.refresh !== false) {
      await this.refreshNow('manual')
    }
    return this.current
  }

  async refreshNow(reason: string): Promise<DefaultMediaResponse> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.fetchAndUpdate(reason).finally(() => {
      this.refreshPromise = undefined
    })

    return this.refreshPromise
  }

  private async fetchAndUpdate(reason: string): Promise<DefaultMediaResponse> {
    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()
    if (!pairingService.isPairedDevice() || !deviceId) {
      logger.debug('Skipping default media fetch: device not paired')
      return this.current
    }

    try {
      const settingsClient = getSettingsClient()
      const fetched = await settingsClient.getDefaultMedia(deviceId)
      const next = await this.hydrateWithCache(fetched)
      const changed = this.hasChanged(this.current, next)

      this.current = next
      this.persistCache(next).catch((error) => {
        logger.warn({ error }, 'Failed to persist default media cache')
      })

      if (changed) {
        this.emit('changed', next)
        if (this.mainWindow) {
          this.mainWindow.webContents.send('default-media:changed', next)
        }
      }

      logger.info(
        { reason, changed, hasMedia: Boolean(next.media_id), source: next.source, aspectRatio: next.aspect_ratio },
        'Default media refreshed'
      )
      return next
    } catch (error) {
      logger.warn({ error, reason }, 'Failed to refresh default media')
      return this.current
    }
  }

  private hasChanged(previous: DefaultMediaResponse, next: DefaultMediaResponse): boolean {
    if (previous.media_id !== next.media_id) {
      return true
    }

    if (previous.source !== next.source || previous.aspect_ratio !== next.aspect_ratio) {
      return true
    }

    if (!previous.media || !next.media) {
      return previous.media !== next.media
    }

    return (
      previous.media.id !== next.media.id ||
      previous.media.media_url !== next.media.media_url ||
      previous.media.local_url !== next.media.local_url ||
      previous.media.type !== next.media.type ||
      previous.media.name !== next.media.name ||
      previous.media.source_content_type !== next.media.source_content_type
    )
  }

  private async loadCached(): Promise<void> {
    if (!fs.existsSync(this.cachePath)) {
      return
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'))
      const cached = normalizeDefaultMediaResponse(raw)
      const hydrated = await this.hydrateFromExistingCache(cached)
      this.current = hydrated
      if (hydrated.media_id) {
        logger.info({ mediaId: hydrated.media_id }, 'Loaded cached default media')
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to load cached default media')
    }
  }

  private async persistCache(payload: DefaultMediaResponse): Promise<void> {
    await atomicWrite(this.cachePath, JSON.stringify(payload, null, 2))
  }

  private async hydrateWithCache(payload: DefaultMediaResponse): Promise<DefaultMediaResponse> {
    const media = payload.media
    const mediaId = payload.media_id

    if (!media || !mediaId) {
      return payload
    }

    const cacheManager = getCacheManager()

    try {
      if (media.media_url) {
        await cacheManager.add(mediaId, media.media_url)
      }
    } catch (error) {
      logger.warn({ error, mediaId }, 'Failed to cache resolved default media')
    }

    const localPath = await cacheManager.get(mediaId)
    if (!localPath) {
      return payload
    }

    return {
      ...payload,
      media: {
        ...media,
        local_path: localPath,
        local_url: pathToFileURL(localPath).toString(),
      },
    }
  }

  private async hydrateFromExistingCache(payload: DefaultMediaResponse): Promise<DefaultMediaResponse> {
    const media = payload.media
    const mediaId = payload.media_id

    if (!media || !mediaId) {
      return payload
    }

    try {
      const cacheManager = getCacheManager()
      const localPath = await cacheManager.get(mediaId)
      if (!localPath) {
        return payload
      }

      return {
        ...payload,
        media: {
          ...media,
          local_path: localPath,
          local_url: pathToFileURL(localPath).toString(),
        },
      }
    } catch (error) {
      logger.warn({ error, mediaId }, 'Failed to hydrate cached default media')
      return payload
    }
  }
}

let defaultMediaService: DefaultMediaService | null = null

export function getDefaultMediaService(): DefaultMediaService {
  if (!defaultMediaService) {
    defaultMediaService = new DefaultMediaService()
  }
  return defaultMediaService
}
