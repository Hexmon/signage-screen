/**
 * Snapshot Parser - Normalize device snapshot payloads into playback items
 */

import { DeviceSnapshot, FitMode, MediaType, SnapshotMediaUrlMap, TimelineItem } from '../../common/types'
import { getLogger } from '../../common/logger'

const logger = getLogger('snapshot-parser')

export interface NormalizedSnapshot {
  snapshotId?: string
  scheduleId?: string
  items: TimelineItem[]
  emergencyItem?: TimelineItem
  defaultItem?: TimelineItem
  mediaUrlMap: SnapshotMediaUrlMap
  fetchedAt: string
  raw?: unknown
}

function inferTypeFromUrl(url?: string): MediaType {
  if (!url) {
    return 'image'
  }

  const lower = url.toLowerCase()
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/.test(lower)) {
    return 'video'
  }
  if (/\.(pdf)(\?|#|$)/.test(lower)) {
    return 'pdf'
  }
  if (/\.(jpg|jpeg|png|gif|webp)(\?|#|$)/.test(lower)) {
    return 'image'
  }
  return 'image'
}

function normalizeFit(fit?: string): FitMode {
  if (fit === 'cover' || fit === 'stretch' || fit === 'contain') {
    return fit
  }
  return 'contain'
}

function normalizeItem(input: any, mediaUrlMap: SnapshotMediaUrlMap): TimelineItem | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const mediaId = input.media_id || input.mediaId || input.id
  const remoteUrl = input.media_url || input.url || (mediaId ? mediaUrlMap[mediaId] : undefined)
  const type: MediaType = input.type || input.media_type || inferTypeFromUrl(remoteUrl)
  const displayMs =
    Number(input.display_ms ?? input.displayMs ?? input.duration_ms ?? input.durationMs ?? 10000) || 10000
  const fit = normalizeFit(input.fit || input.fit_mode)
  const muted = Boolean(input.muted ?? false)
  const transitionDurationMs = Number(input.transition_ms ?? input.transitionDurationMs ?? 0) || 0

  const id = input.id || mediaId || `item-${Math.random().toString(36).slice(2, 8)}`

  return {
    id,
    mediaId: mediaId || id,
    type,
    remoteUrl,
    displayMs,
    fit,
    muted,
    sha256: input.sha256,
    meta: input.meta,
    transitionDurationMs,
  }
}

function extractMediaUrlMap(payload: DeviceSnapshot): SnapshotMediaUrlMap {
  const map: SnapshotMediaUrlMap = {}

  const rawMap = payload.media_urls || payload.mediaUrls
  if (rawMap && typeof rawMap === 'object') {
    for (const [key, value] of Object.entries(rawMap)) {
      if (typeof value === 'string') {
        map[key] = value
      }
    }
  }

  if (Array.isArray(payload.media)) {
    for (const entry of payload.media) {
      const mediaId = entry.media_id || entry.mediaId
      const url = entry.url || entry.media_url
      if (mediaId && url) {
        map[mediaId] = url
      }
    }
  }

  return map
}

export function parseSnapshotResponse(raw: unknown): NormalizedSnapshot {
  const payload = (raw as any)?.snapshot || (raw as any)?.data || raw

  if (!payload || typeof payload !== 'object') {
    throw new Error('Snapshot payload is not an object')
  }

  const snapshot = payload as DeviceSnapshot
  const mediaUrlMap = extractMediaUrlMap(snapshot)

  const schedule = snapshot.schedule
  const itemsSource = Array.isArray(schedule?.items) ? schedule?.items : snapshot.items
  const items = (itemsSource || [])
    .map((item) => normalizeItem(item, mediaUrlMap))
    .filter(Boolean) as TimelineItem[]

  const emergencyInput = snapshot.emergency
  const emergencyActive =
    emergencyInput && (emergencyInput.active === true || Boolean(emergencyInput.media_url || emergencyInput.url))
  const emergencyItem = emergencyActive ? normalizeItem(emergencyInput, mediaUrlMap) || undefined : undefined

  const defaultInput = snapshot.default_media
  const defaultItem = defaultInput ? normalizeItem(defaultInput, mediaUrlMap) || undefined : undefined

  const normalized: NormalizedSnapshot = {
    snapshotId: snapshot.id || snapshot.snapshot_id,
    scheduleId: schedule?.id,
    items,
    emergencyItem,
    defaultItem,
    mediaUrlMap,
    fetchedAt: snapshot.fetched_at || snapshot.generated_at || new Date().toISOString(),
    raw,
  }

  logger.debug(
    {
      snapshotId: normalized.snapshotId,
      scheduleId: normalized.scheduleId,
      itemCount: normalized.items.length,
      hasEmergency: Boolean(normalized.emergencyItem),
      hasDefault: Boolean(normalized.defaultItem),
    },
    'Snapshot parsed'
  )

  return normalized
}
