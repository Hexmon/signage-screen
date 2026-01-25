/**
 * Settings Client - Fetch CMS settings (default media, etc.)
 */

import { getLogger } from '../../../common/logger'
import { DefaultMediaResponse, DefaultMediaItem, DefaultMediaType } from '../../../common/types'
import { getHttpClient } from '../network/http-client'

const logger = getLogger('settings-client')

const VALID_MEDIA_TYPES: DefaultMediaType[] = ['IMAGE', 'VIDEO', 'DOCUMENT']

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
  const sourceContentType = typeof input.source_content_type === 'string' ? input.source_content_type : undefined

  if (!id || !type || !mediaUrl) {
    return null
  }

  return {
    id,
    name,
    type,
    media_url: mediaUrl,
    source_content_type: sourceContentType,
  }
}

export function normalizeDefaultMediaResponse(raw: unknown): DefaultMediaResponse {
  if (!raw || typeof raw !== 'object') {
    return { media_id: null, media: null }
  }

  const payload = raw as any
  const mediaId = typeof payload.media_id === 'string' ? payload.media_id : null
  const media = normalizeMediaItem(payload.media)

  if (!mediaId || !media) {
    return { media_id: null, media: null }
  }

  return { media_id: mediaId, media }
}

export class SettingsClient {
  async getDefaultMedia(): Promise<DefaultMediaResponse> {
    const httpClient = getHttpClient()
    const response = await httpClient.get('/api/v1/settings/default-media')
    const normalized = normalizeDefaultMediaResponse(response)

    if (!normalized.media_id || !normalized.media) {
      logger.debug('Default media not set')
    } else {
      logger.debug({ mediaId: normalized.media_id, type: normalized.media.type }, 'Default media fetched')
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
