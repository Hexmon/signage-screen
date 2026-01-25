/**
 * Unit tests for settings client default media parsing
 */

const { expect } = require('chai')
const { normalizeDefaultMediaResponse } = require('../../../src/main/services/settings/settings-client.ts')

describe('Settings Client', () => {
  it('should parse default media response with media', () => {
    const raw = {
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

    expect(parsed.media_id).to.equal('media-123')
    expect(parsed.media).to.exist
    expect(parsed.media?.id).to.equal('media-123')
    expect(parsed.media?.type).to.equal('IMAGE')
    expect(parsed.media?.media_url).to.equal('https://cdn.example.com/media-123.png')
  })

  it('should return nulls when default media is not set', () => {
    const raw = {
      media_id: null,
      media: null,
    }

    const parsed = normalizeDefaultMediaResponse(raw)

    expect(parsed.media_id).to.equal(null)
    expect(parsed.media).to.equal(null)
  })
})
