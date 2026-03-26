/**
 * Settings Client - Fetch CMS settings (default media, etc.)
 */

import { getLogger } from '../../../common/logger'
import { DefaultMediaResponse, DefaultMediaItem, DefaultMediaType } from '../../../common/types'
import { getHttpClient } from '../network/http-client'

const logger = getLogger('settings-client')

const VALID_MEDIA_TYPES: DefaultMediaType[] = ['IMAGE', 'VIDEO', 'DOCUMENT', 'WEBPAGE']

function normalizeMediaItem(input: any): DefaultMediaItem | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const id = typeof input.id === 'string' ? input.id : undefined
  const name = typeof input.name === 'string' ? input.name : 'Untitled media'
  const type = typeof input.type === 'string' && VALID_MEDIA_TYPES.includes(input.type as DefaultMediaType)
    ? (input.type as DefaultMediaType)
    : undefined
  const mediaUrl = typeof input.media_url === 'string' ? input.media_url : undefined
  const sourceUrl = typeof input.source_url === 'string' ? input.source_url : undefined
  const fallbackMediaUrl = typeof input.fallback_media_url === 'string' ? input.fallback_media_url : undefined
  const contentType = typeof input.content_type === 'string' ? input.content_type : undefined
  const sourceContentType = typeof input.source_content_type === 'string' ? input.source_content_type : undefined

  const hasPlayableWebpagePayload = type === 'WEBPAGE' && Boolean(sourceUrl || fallbackMediaUrl || mediaUrl)
  if (!id || !type || (!mediaUrl && !hasPlayableWebpagePayload)) {
    return null
  }

  return {
    id,
    name,
    type,
    content_type: contentType,
    media_url: mediaUrl,
    source_url: sourceUrl,
    fallback_media_url: fallbackMediaUrl,
    source_content_type: sourceContentType,
  }
}

export function normalizeDefaultMediaResponse(raw: unknown): DefaultMediaResponse {
  if (!raw || typeof raw !== 'object') {
    return { source: 'NONE', aspect_ratio: null, media_id: null, media: null }
  }

  const payload = raw as any
  const source =
    payload.source === 'SCREEN' ||
    payload.source === 'GROUP' ||
    payload.source === 'ASPECT_RATIO' ||
    payload.source === 'GLOBAL' ||
    payload.source === 'NONE'
      ? payload.source
      : undefined
  const aspectRatio = typeof payload.aspect_ratio === 'string' ? payload.aspect_ratio : null
  const mediaId = typeof payload.media_id === 'string' ? payload.media_id : null
  const media = normalizeMediaItem(payload.media)

  if (!mediaId || !media) {
    return { source: source || 'NONE', aspect_ratio: aspectRatio, media_id: null, media: null }
  }

  return { source: source || 'GLOBAL', aspect_ratio: aspectRatio, media_id: mediaId, media }
}

export class SettingsClient {
  async getDefaultMedia(deviceId: string): Promise<DefaultMediaResponse> {
    const httpClient = getHttpClient()
    const response = await httpClient.get(`/api/v1/device/${deviceId}/default-media`)
    const normalized = normalizeDefaultMediaResponse(response)

    if (!normalized.media_id || !normalized.media) {
      logger.debug({ deviceId, source: normalized.source }, 'Resolved default media not set')
    } else {
      logger.debug(
        { deviceId, mediaId: normalized.media_id, type: normalized.media.type, source: normalized.source, aspectRatio: normalized.aspect_ratio },
        'Resolved default media fetched'
      )
    }

    return normalized
  }
}

let settingsClient: SettingsClient | null = null

export function getSettingsClient(): SettingsClient {
  if (!settingsClient) {
    settingsClient = new SettingsClient()
  }
  return settingsClient
}
