/**
 * Snapshot Parser - Normalize device snapshot payloads into playback items
 */

import { DeviceSnapshot, FitMode, MediaType, SnapshotMediaUrlMap, TimelineItem } from '../../common/types'
import { getLogger } from '../../common/logger'
import { NormalizedScheduleWindow, normalizeScheduleWindows } from './snapshot-evaluator'

const logger = getLogger('snapshot-parser')

export interface NormalizedSnapshot {
  snapshotId?: string
  scheduleId?: string
  scheduleTimezone?: string | null
  contentState: 'scheduled' | 'default' | 'empty'
  serverTime?: string
  items: TimelineItem[]
  scheduleWindows: NormalizedScheduleWindow[]
  emergencyItem?: TimelineItem
  emergencyExpiresAt?: string | null
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

function normalizeMediaType(value?: string): MediaType {
  if (!value) {
    return 'image'
  }

  const normalized = value.toLowerCase()
  if (normalized === 'image') return 'image'
  if (normalized === 'video') return 'video'
  if (normalized === 'pdf') return 'pdf'
  if (normalized === 'document') return 'office'
  if (normalized === 'office') return 'office'
  if (normalized === 'url') return 'url'
  if (normalized === 'webpage') return 'url'
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized.includes('pdf')) return 'pdf'
  if (
    normalized.includes('spreadsheet') ||
    normalized.includes('excel') ||
    normalized.includes('msword') ||
    normalized.includes('wordprocessingml') ||
    normalized.includes('presentation') ||
    normalized.includes('powerpoint') ||
    normalized === 'text/csv'
  ) {
    return 'office'
  }
  return inferTypeFromUrl(value)
}

function normalizeItem(input: any, mediaUrlMap: SnapshotMediaUrlMap): TimelineItem | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const mediaId = input.media_id || input.mediaId || input.id
  const contentType = typeof input.content_type === 'string' ? input.content_type : undefined
  const sourceContentType = typeof input.source_content_type === 'string' ? input.source_content_type : undefined
  const explicitType = normalizeMediaType(input.type || input.media_type)
  const type: MediaType =
    explicitType === 'url'
      ? 'url'
      : normalizeMediaType(contentType || sourceContentType || input.type || input.media_type || input.source_url || input.url || input.media_url)
  const remoteUrl =
    type === 'url'
      ? input.url || input.source_url || input.media_url || (mediaId ? mediaUrlMap[mediaId] : undefined)
      : input.media_url || input.url || (mediaId ? mediaUrlMap[mediaId] : undefined)
  const displayMs =
    Number(input.display_ms ?? input.displayMs ?? input.duration_ms ?? input.durationMs ?? 10000) || 10000
  const fit = normalizeFit(input.fit || input.fit_mode)
  const muted = Boolean(input.muted ?? false)
  const transitionDurationMs = Number(input.transition_ms ?? input.transitionDurationMs ?? 0) || 0
  const loop = Boolean(input.loop ?? input.loop_enabled ?? false)

  const id = input.id || mediaId || `item-${Math.random().toString(36).slice(2, 8)}`

  return {
    id,
    mediaId: mediaId || id,
    type,
    remoteUrl,
    displayMs,
    fit,
    muted,
    loop,
    sha256: input.sha256,
    meta: {
      ...(input.meta && typeof input.meta === 'object' ? input.meta : {}),
      source_url: typeof input.source_url === 'string' ? input.source_url : undefined,
      fallback_url:
        typeof input.fallback_url === 'string'
          ? input.fallback_url
          : type === 'url' && typeof input.media_url === 'string'
            ? input.media_url
            : undefined,
      name: typeof input.name === 'string' ? input.name : undefined,
      content_type: contentType,
      source_content_type: sourceContentType,
    },
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
      const type = normalizeMediaType(entry.type || entry.media_type)
      const url = type === 'url' ? entry.url || entry.source_url || entry.media_url : entry.url || entry.media_url
      if (mediaId && url) {
        map[mediaId] = url
      }
    }
  }

  return map
}

export function parseSnapshotResponse(raw: unknown): NormalizedSnapshot {
  const wrapper = raw as any
  const payloadCandidate = wrapper?.snapshot || wrapper?.data || raw
  const payload =
    payloadCandidate && typeof payloadCandidate === 'object'
      ? payloadCandidate
      : wrapper && typeof wrapper === 'object'
        ? {}
        : payloadCandidate

  if (!payload || typeof payload !== 'object') {
    throw new Error('Snapshot payload is not an object')
  }

  const snapshot = payload as DeviceSnapshot
  const rootDefaultMedia =
    wrapper?.snapshot && typeof wrapper === 'object' ? wrapper.default_media ?? snapshot.default_media : snapshot.default_media
  const rootEmergency =
    wrapper?.snapshot && typeof wrapper === 'object' ? wrapper.emergency ?? snapshot.emergency : snapshot.emergency
  const mediaCarrier =
    wrapper?.snapshot && typeof wrapper === 'object'
      ? {
          ...snapshot,
          media_urls: wrapper.media_urls ?? snapshot.media_urls,
          mediaUrls: wrapper.mediaUrls ?? snapshot.mediaUrls,
          media: wrapper.media ?? snapshot.media,
          default_media: rootDefaultMedia,
          emergency: rootEmergency,
        }
      : snapshot
  const mediaUrlMap = extractMediaUrlMap(mediaCarrier as DeviceSnapshot)

  const schedule = snapshot.schedule
  const scheduleItems = Array.isArray(schedule?.items) ? schedule.items : []
  const hasTimedWindowPayload = scheduleItems.some((item) => {
    if (!item || typeof item !== 'object') {
      return false
    }

    return Boolean(item.presentation || item.presentation_id || item.start_at || item.end_at)
  })

  const itemsSource = hasTimedWindowPayload ? snapshot.items : scheduleItems.length > 0 ? scheduleItems : snapshot.items
  const items = (itemsSource || [])
    .map((item) => normalizeItem(item, mediaUrlMap))
    .filter(Boolean) as TimelineItem[]
  const scheduleWindows = normalizeScheduleWindows(scheduleItems, mediaUrlMap)

  const emergencyInput = rootEmergency
  const emergencyExpired =
    typeof emergencyInput?.expires_at === 'string' && Number.isFinite(Date.parse(emergencyInput.expires_at))
      ? Date.parse(emergencyInput.expires_at) <= Date.now()
      : false
  const emergencyActive =
    !emergencyExpired &&
    emergencyInput &&
    (emergencyInput.active === true || Boolean(emergencyInput.media_url || emergencyInput.url))
  const emergencyItem = emergencyActive ? normalizeItem(emergencyInput, mediaUrlMap) || undefined : undefined

  const defaultInput = rootDefaultMedia
  const defaultItem = defaultInput ? normalizeItem(defaultInput, mediaUrlMap) || undefined : undefined

  const normalized: NormalizedSnapshot = {
    snapshotId: snapshot.id || snapshot.snapshot_id,
    scheduleId: schedule?.id,
    scheduleTimezone: schedule?.timezone ?? null,
    contentState:
      wrapper?.content_state === 'scheduled' || wrapper?.content_state === 'default' || wrapper?.content_state === 'empty'
        ? wrapper.content_state
        : snapshot.schedule || scheduleItems.length > 0 || items.length > 0
          ? 'scheduled'
          : defaultItem
            ? 'default'
            : 'empty',
    serverTime: typeof wrapper?.server_time === 'string' ? wrapper.server_time : undefined,
    items,
    scheduleWindows,
    emergencyItem,
    emergencyExpiresAt: emergencyExpired ? null : emergencyInput?.expires_at ?? null,
    defaultItem,
    mediaUrlMap,
    fetchedAt: snapshot.fetched_at || snapshot.generated_at || new Date().toISOString(),
    raw,
  }

  logger.debug(
    {
      snapshotId: normalized.snapshotId,
      scheduleId: normalized.scheduleId,
      contentState: normalized.contentState,
      itemCount: normalized.items.length,
      scheduleWindowCount: normalized.scheduleWindows.length,
      hasEmergency: Boolean(normalized.emergencyItem),
      hasDefault: Boolean(normalized.defaultItem),
    },
    'Snapshot parsed'
  )

  return normalized
}
