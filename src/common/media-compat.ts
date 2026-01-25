/**
 * Media compatibility helper
 */

export type MediaKind = 'IMAGE' | 'VIDEO' | 'DOCUMENT'
export type CompatStatus = 'PLAYABLE_NOW' | 'ACCEPTED_BUT_NOT_SUPPORTED_YET' | 'REJECTED'

export interface CompatResult {
  status: CompatStatus
  kind: MediaKind | 'UNKNOWN'
  reason: string
  normalizedExt?: string
  normalizedMime?: string
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp'])
const VIDEO_EXT = new Set(['mp4', 'mov'])
const DOC_EXT = new Set(['pdf', 'ppt', 'pptx', 'csv', 'doc', 'docx'])

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime'])
const DOC_MIME = new Set([
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

type MediaInput = {
  type?: string
  media_type?: string
  mediaType?: string
  source_content_type?: string
  sourceContentType?: string
  content_type?: string
  contentType?: string
  name?: string
  media_url?: string
  mediaUrl?: string
  url?: string
}

function normalizeType(raw?: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined
  return raw.trim().toUpperCase()
}

export function normalizeMime(mime?: string): string | undefined {
  if (!mime || typeof mime !== 'string') return undefined
  const normalized = mime.split(';')[0]?.trim().toLowerCase()
  return normalized || undefined
}

export function getExtensionFromName(name?: string): string | undefined {
  if (!name || typeof name !== 'string') return undefined
  const sanitized = name.split('?')[0]?.split('#')[0] || name
  const base = sanitized.split(/[\\/]/).pop() || sanitized
  const lastDot = base.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === base.length - 1) return undefined
  return base.slice(lastDot + 1).toLowerCase()
}

export function getExtensionFromUrl(url?: string): string | undefined {
  if (!url || typeof url !== 'string') return undefined

  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname || ''
    const segment = pathname.split('/').pop() || ''
    const lastDot = segment.lastIndexOf('.')
    if (lastDot <= 0 || lastDot === segment.length - 1) return undefined
    return segment.slice(lastDot + 1).toLowerCase()
  } catch {
    const sanitized = url.split('?')[0]?.split('#')[0] || url
    const segment = sanitized.split('/').pop() || sanitized
    const lastDot = segment.lastIndexOf('.')
    if (lastDot <= 0 || lastDot === segment.length - 1) return undefined
    return segment.slice(lastDot + 1).toLowerCase()
  }
}

function getKindFromRawType(rawType?: string): MediaKind | undefined {
  if (!rawType) return undefined

  if (rawType === 'IMAGE') return 'IMAGE'
  if (rawType === 'VIDEO') return 'VIDEO'
  if (rawType === 'DOCUMENT') return 'DOCUMENT'
  if (rawType === 'PDF') return 'DOCUMENT'
  if (rawType === 'OFFICE') return 'DOCUMENT'

  if (rawType === 'URL') return undefined

  return undefined
}

function getKindFromType(media: MediaInput): MediaKind | undefined {
  const rawType = normalizeType(media.type || media.media_type || media.mediaType)
  return getKindFromRawType(rawType)
}

function getKindFromMime(mime?: string): MediaKind | undefined {
  if (!mime) return undefined
  if (IMAGE_MIME.has(mime)) return 'IMAGE'
  if (VIDEO_MIME.has(mime)) return 'VIDEO'
  if (DOC_MIME.has(mime)) return 'DOCUMENT'
  return undefined
}

function getKindFromExt(ext?: string): MediaKind | undefined {
  if (!ext) return undefined
  if (IMAGE_EXT.has(ext)) return 'IMAGE'
  if (VIDEO_EXT.has(ext)) return 'VIDEO'
  if (DOC_EXT.has(ext)) return 'DOCUMENT'
  return undefined
}

export function inferKind(media: MediaInput): MediaKind | 'UNKNOWN' {
  const typeHint = getKindFromType(media)
  if (typeHint) return typeHint

  const mime = normalizeMime(
    media.source_content_type || media.sourceContentType || media.content_type || media.contentType
  )
  const mimeKind = getKindFromMime(mime)
  if (mimeKind) return mimeKind

  const extFromName = getExtensionFromName(media.name)
  const extFromUrl = getExtensionFromUrl(media.media_url || media.mediaUrl || media.url)
  const extKind = getKindFromExt(extFromName || extFromUrl)
  if (extKind) return extKind

  return 'UNKNOWN'
}

function buildResult(
  status: CompatStatus,
  kind: MediaKind | 'UNKNOWN',
  reason: string,
  normalizedExt?: string,
  normalizedMime?: string
): CompatResult {
  return {
    status,
    kind,
    reason,
    normalizedExt,
    normalizedMime,
  }
}

export function checkMediaCompatibility(media: MediaInput): CompatResult {
  const rawType = normalizeType(media.type || media.media_type || media.mediaType)
  const normalizedMime = normalizeMime(
    media.source_content_type || media.sourceContentType || media.content_type || media.contentType
  )
  const extFromName = getExtensionFromName(media.name)
  const extFromUrl = getExtensionFromUrl(media.media_url || media.mediaUrl || media.url)
  const normalizedExt = extFromName || extFromUrl

  const typeHint = getKindFromRawType(rawType)
  const kind = inferKind(media)

  const isImageExt = normalizedExt ? IMAGE_EXT.has(normalizedExt) : false
  const isVideoExt = normalizedExt ? VIDEO_EXT.has(normalizedExt) : false
  const isDocExt = normalizedExt ? DOC_EXT.has(normalizedExt) : false

  const isImageMime = normalizedMime ? IMAGE_MIME.has(normalizedMime) : false
  const isVideoMime = normalizedMime ? VIDEO_MIME.has(normalizedMime) : false
  const isDocMime = normalizedMime ? DOC_MIME.has(normalizedMime) : false

  const isPdf = normalizedExt === 'pdf' || normalizedMime === 'application/pdf' || rawType === 'PDF'

  if (kind === 'IMAGE') {
    if (isImageExt || isImageMime) {
      return buildResult('PLAYABLE_NOW', 'IMAGE', 'image supported', normalizedExt, normalizedMime)
    }

    if (!normalizedExt && !normalizedMime && typeHint === 'IMAGE') {
      return buildResult('PLAYABLE_NOW', 'IMAGE', 'image type hint only', normalizedExt, normalizedMime)
    }

    return buildResult('REJECTED', 'IMAGE', 'image type not supported', normalizedExt, normalizedMime)
  }

  if (kind === 'VIDEO') {
    if (isVideoExt || isVideoMime) {
      return buildResult('PLAYABLE_NOW', 'VIDEO', 'video supported', normalizedExt, normalizedMime)
    }

    if (!normalizedExt && !normalizedMime && typeHint === 'VIDEO') {
      return buildResult('PLAYABLE_NOW', 'VIDEO', 'video type hint only', normalizedExt, normalizedMime)
    }

    return buildResult('REJECTED', 'VIDEO', 'video type not supported', normalizedExt, normalizedMime)
  }

  if (kind === 'DOCUMENT') {
    if (isPdf) {
      return buildResult('PLAYABLE_NOW', 'DOCUMENT', 'pdf supported', normalizedExt, normalizedMime)
    }

    if (isDocExt || isDocMime) {
      return buildResult(
        'ACCEPTED_BUT_NOT_SUPPORTED_YET',
        'DOCUMENT',
        'document type not supported yet',
        normalizedExt,
        normalizedMime
      )
    }

    if (!normalizedExt && !normalizedMime && typeHint === 'DOCUMENT') {
      return buildResult(
        'ACCEPTED_BUT_NOT_SUPPORTED_YET',
        'DOCUMENT',
        'document type unknown',
        normalizedExt,
        normalizedMime
      )
    }

    return buildResult('REJECTED', 'DOCUMENT', 'document type not supported', normalizedExt, normalizedMime)
  }

  return buildResult('REJECTED', 'UNKNOWN', 'unable to infer media type', normalizedExt, normalizedMime)
}

export const MEDIA_COMPAT_ALLOWLISTS = {
  IMAGE_EXT,
  VIDEO_EXT,
  DOC_EXT,
  IMAGE_MIME,
  VIDEO_MIME,
  DOC_MIME,
}
