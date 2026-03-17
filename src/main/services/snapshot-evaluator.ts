import {
  FitMode,
  MediaType,
  SnapshotMediaUrlMap,
  SnapshotPresentation,
  SnapshotScheduleItem,
  TimelineItem,
} from '../../common/types'

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

function inferTypeFromValue(value?: string): MediaType {
  if (!value) return 'image'
  const normalized = value.toLowerCase()
  if (normalized === 'image' || normalized.startsWith('image/')) return 'image'
  if (normalized === 'video' || normalized.startsWith('video/')) return 'video'
  if (normalized === 'pdf' || normalized.includes('pdf')) return 'pdf'
  if (normalized === 'office' || normalized.includes('presentation') || normalized.includes('powerpoint')) return 'office'
  if (normalized === 'url') return 'url'
  return 'image'
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
  remoteUrl?: string
  durationSeconds?: number
  fit?: string
  muted?: boolean
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
    type: inferTypeFromValue(input.mediaType),
    displayMs: Math.max(1, Number(input.durationSeconds || 10)) * 1000,
    fit: normalizeFit(input.fit),
    muted: Boolean(input.muted),
    transitionDurationMs: 0,
    meta: input.meta,
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
        remoteUrl: entry.media_id ? mediaUrlMap[entry.media_id] : undefined,
        durationSeconds: entry.duration_seconds,
        fit: 'contain',
        muted: true,
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
        remoteUrl: entry.media_id ? mediaUrlMap[entry.media_id] : undefined,
        durationSeconds: entry.duration_seconds,
        fit: entry.fit_mode,
        muted: entry.audio_enabled === true ? false : true,
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
