/**
 * Unit tests for settings client default media parsing
 */

const { expect } = require('chai')
const { normalizeDefaultMediaResponse } = require('../../../src/main/services/settings/settings-client.ts')

describe('Settings Client', () => {
  it('should parse default media response with media', () => {
    const raw = {
      source: 'ASPECT_RATIO',
      aspect_ratio: '16:9',
      media_id: 'media-123',
      media: {
        id: 'media-123',
        name: 'Lobby Image',
        type: 'IMAGE',
        source_content_type: 'image/png',
        media_url: 'https://cdn.example.com/media-123.png',
      },
    }

    const parsed = normalizeDefaultMediaResponse(raw)

    expect(parsed.source).to.equal('ASPECT_RATIO')
    expect(parsed.aspect_ratio).to.equal('16:9')
    expect(parsed.media_id).to.equal('media-123')
    expect(parsed.media).to.exist
    expect(parsed.media?.id).to.equal('media-123')
    expect(parsed.media?.type).to.equal('IMAGE')
    expect(parsed.media?.media_url).to.equal('https://cdn.example.com/media-123.png')
  })

  it('should return nulls when default media is not set', () => {
    const raw = {
      source: 'NONE',
      aspect_ratio: '4:3',
      media_id: null,
      media: null,
    }

    const parsed = normalizeDefaultMediaResponse(raw)

    expect(parsed.source).to.equal('NONE')
    expect(parsed.aspect_ratio).to.equal('4:3')
    expect(parsed.media_id).to.equal(null)
    expect(parsed.media).to.equal(null)
  })

  it('should fall back to NONE when response shape is invalid', () => {
    const parsed = normalizeDefaultMediaResponse({ foo: 'bar' })

    expect(parsed.source).to.equal('NONE')
    expect(parsed.media_id).to.equal(null)
    expect(parsed.media).to.equal(null)
  })

  it('should parse webpage default media with fallback preview metadata', () => {
    const raw = {
      source: 'GLOBAL',
      media_id: 'media-webpage',
      media: {
        id: 'media-webpage',
        name: 'Status Dashboard',
        type: 'WEBPAGE',
        source_content_type: 'text/html',
        source_url: 'https://status.example.com',
        media_url: 'https://cdn.example.com/webpage-fallback.svg',
        fallback_media_url: 'https://cdn.example.com/webpage-fallback.svg',
      },
    }

    const parsed = normalizeDefaultMediaResponse(raw)

    expect(parsed.source).to.equal('GLOBAL')
    expect(parsed.media_id).to.equal('media-webpage')
    expect(parsed.media?.type).to.equal('WEBPAGE')
    expect(parsed.media?.source_url).to.equal('https://status.example.com')
    expect(parsed.media?.fallback_media_url).to.equal('https://cdn.example.com/webpage-fallback.svg')
    expect(parsed.media?.media_url).to.equal('https://cdn.example.com/webpage-fallback.svg')
  })

  it('should parse webpage default media when only a live source_url is available', () => {
    const raw = {
      source: 'GLOBAL',
      media_id: 'media-webpage-live',
      media: {
        id: 'media-webpage-live',
        name: 'Live Status',
        type: 'WEBPAGE',
        source_content_type: 'text/html',
        source_url: 'https://status.example.com/live',
        media_url: null,
        fallback_media_url: null,
      },
    }

    const parsed = normalizeDefaultMediaResponse(raw)

    expect(parsed.source).to.equal('GLOBAL')
    expect(parsed.media_id).to.equal('media-webpage-live')
    expect(parsed.media?.type).to.equal('WEBPAGE')
    expect(parsed.media?.source_url).to.equal('https://status.example.com/live')
    expect(parsed.media?.media_url).to.equal(undefined)
    expect(parsed.media?.fallback_media_url).to.equal(undefined)
  })
})
