import {
  FitMode,
  MediaType,
  SnapshotMediaUrlMap,
  SnapshotPresentation,
  SnapshotScheduleItem,
  TimelineItem,
} from '../../common/types'
import { getExtensionFromName, getExtensionFromUrl, normalizeMime } from '../../common/media-compat'

export interface NormalizedScheduleWindow {
  id: string
  presentationId?: string
  presentationName?: string
  startAt?: string
  endAt?: string
  priority: number
  items: TimelineItem[]
  layout?: SnapshotPresentation['layout']
  raw?: SnapshotScheduleItem
}

export interface ScheduleEvaluationResult {
  activeWindow?: NormalizedScheduleWindow
  items: TimelineItem[]
  nextTransitionAt?: number
}

function inferTypeFromValue(input: {
  mediaType?: string
  sourceContentType?: string
  mediaName?: string
  remoteUrl?: string
}): MediaType {
  const normalizedType = input.mediaType?.toLowerCase()
  const normalizedMime = normalizeMime(input.sourceContentType)
  const extension = getExtensionFromName(input.mediaName) || getExtensionFromUrl(input.remoteUrl)

  if (normalizedType === 'image' || normalizedMime?.startsWith('image/')) return 'image'
  if (normalizedType === 'video' || normalizedMime?.startsWith('video/')) return 'video'
  if (normalizedType === 'url') return 'url'

  if (
    normalizedType === 'pdf' ||
    normalizedMime === 'application/pdf' ||
    extension === 'pdf'
  ) {
    return 'pdf'
  }

  if (
    normalizedType === 'office' ||
    normalizedType === 'document' ||
    normalizedMime?.includes('presentation') ||
    normalizedMime?.includes('powerpoint') ||
    normalizedMime === 'text/csv' ||
    normalizedMime === 'application/msword' ||
    normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    extension === 'ppt' ||
    extension === 'pptx' ||
    extension === 'csv' ||
    extension === 'doc' ||
    extension === 'docx'
  ) {
    return 'office'
  }

  if (normalizedType?.startsWith('image/')) return 'image'
  if (normalizedType?.startsWith('video/')) return 'video'
  if (normalizedType?.includes('pdf')) return 'pdf'

  return extension === 'mp4' || extension === 'mov' ? 'video' : 'image'
}

function normalizeFit(value?: string): FitMode {
  if (value === 'cover' || value === 'stretch' || value === 'contain') {
    return value
  }
  return 'contain'
}

function buildTimelineItem(input: {
  id?: string
  mediaId?: string
  mediaName?: string
  mediaType?: string
  sourceContentType?: string
  remoteUrl?: string
  durationSeconds?: number
  fit?: string
  muted?: boolean
  loopEnabled?: boolean
  meta?: Record<string, unknown>
}): TimelineItem | null {
  const mediaId = input.mediaId || input.id
  const remoteUrl = input.remoteUrl
  if (!mediaId || !remoteUrl) {
    return null
  }

  return {
    id: input.id || mediaId,
    mediaId,
    remoteUrl,
    type: inferTypeFromValue({
      mediaType: input.mediaType,
      sourceContentType: input.sourceContentType,
      mediaName: input.mediaName,
      remoteUrl,
    }),
    displayMs: Math.max(1, Number(input.durationSeconds || 10)) * 1000,
    fit: normalizeFit(input.fit),
    muted: Boolean(input.muted),
    loop: Boolean(input.loopEnabled),
    transitionDurationMs: 0,
    meta: {
      ...input.meta,
      name: input.mediaName,
      source_content_type: input.sourceContentType,
    },
  }
}

function sortByOrder<T extends { order?: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => (left.order || 0) - (right.order || 0))
}

export function buildWindowItems(
  scheduleItem: SnapshotScheduleItem,
  mediaUrlMap: SnapshotMediaUrlMap,
): TimelineItem[] {
  const presentation = scheduleItem.presentation
  if (!presentation || typeof presentation !== 'object') {
    return []
  }

  const layoutMeta = presentation.layout
    ? {
        layout: presentation.layout,
      }
    : undefined

  const itemsFromPresentation = sortByOrder(presentation.items || [])
    .map((entry) =>
      buildTimelineItem({
        id: entry.id,
        mediaId: entry.media_id,
        mediaName: entry.media?.name,
        mediaType: entry.media?.type,
        sourceContentType: entry.media?.source_content_type,
        remoteUrl: entry.media_id ? mediaUrlMap[entry.media_id] : undefined,
        durationSeconds: entry.duration_seconds,
        fit: 'contain',
        muted: true,
        loopEnabled: false,
        meta: {
          ...layoutMeta,
          source: 'schedule',
          presentationId: presentation.id,
          presentationName: presentation.name,
        },
      }),
    )
    .filter(Boolean) as TimelineItem[]

  const itemsFromSlots = sortByOrder(presentation.slots || [])
    .map((entry) =>
      buildTimelineItem({
        id: entry.id,
        mediaId: entry.media_id,
        mediaName: entry.media?.name,
        mediaType: entry.media?.type,
        sourceContentType: entry.media?.source_content_type,
        remoteUrl: entry.media_id ? mediaUrlMap[entry.media_id] : undefined,
        durationSeconds: entry.duration_seconds,
        fit: entry.fit_mode,
        muted: entry.audio_enabled === true ? false : true,
        loopEnabled: entry.loop_enabled === true,
        meta: {
          ...layoutMeta,
          source: 'schedule',
          slotId: entry.slot_id,
          presentationId: presentation.id,
          presentationName: presentation.name,
        },
      }),
    )
    .filter(Boolean) as TimelineItem[]

  return [...itemsFromPresentation, ...itemsFromSlots]
}

export function normalizeScheduleWindows(
  scheduleItems: SnapshotScheduleItem[] | undefined,
  mediaUrlMap: SnapshotMediaUrlMap,
): NormalizedScheduleWindow[] {
  return (scheduleItems || [])
    .map((item, index) => {
      const items = buildWindowItems(item, mediaUrlMap)
      return {
        id: item.id || `schedule-window-${index}`,
        presentationId: item.presentation_id || item.presentation?.id,
        presentationName: item.presentation?.name,
        startAt: item.start_at,
        endAt: item.end_at,
        priority: Number(item.priority || 0),
        items,
        layout: item.presentation?.layout,
        raw: item,
      }
    })
    .filter((window) => window.items.length > 0)
}

export function evaluateScheduleWindows(
  windows: NormalizedScheduleWindow[],
  nowMs: number = Date.now(),
): ScheduleEvaluationResult {
  if (windows.length === 0) {
    return { items: [] }
  }

  const activeWindows = windows
    .filter((window) => {
      const startMs = window.startAt ? Date.parse(window.startAt) : Number.NaN
      const endMs = window.endAt ? Date.parse(window.endAt) : Number.NaN
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false
      return startMs <= nowMs && nowMs < endMs
    })
    .sort((left, right) => {
      if (right.priority !== left.priority) return right.priority - left.priority
      const rightStart = right.startAt ? Date.parse(right.startAt) : 0
      const leftStart = left.startAt ? Date.parse(left.startAt) : 0
      return rightStart - leftStart
    })

  const boundaryCandidates = windows.flatMap((window) => {
    const starts = window.startAt ? [Date.parse(window.startAt)] : []
    const ends = window.endAt ? [Date.parse(window.endAt)] : []
    return [...starts, ...ends].filter((value) => Number.isFinite(value) && value > nowMs)
  })

  const nextTransitionAt = boundaryCandidates.length > 0 ? Math.min(...boundaryCandidates) : undefined

  if (activeWindows.length === 0) {
    return {
      items: [],
      nextTransitionAt,
    }
  }

  const activeWindow = activeWindows[0]
  if (!activeWindow) {
    return {
      items: [],
      nextTransitionAt,
    }
  }

  return {
    activeWindow,
    items: activeWindow.items,
    nextTransitionAt,
  }
}
