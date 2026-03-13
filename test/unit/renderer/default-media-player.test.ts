const { expect } = require('chai')

describe('Default Media Player helpers', () => {
  it('prefers cached local_url over remote media_url', async () => {
    const { resolveDefaultMediaSource } = await import('../../../src/renderer/default-media-player.ts')

    const source = resolveDefaultMediaSource({
      id: 'media-1',
      name: 'Fallback',
      type: 'IMAGE',
      media_url: 'https://cdn.example.com/fallback.png',
      local_url: 'file:///tmp/fallback.png',
    })

    expect(source).to.equal('file:///tmp/fallback.png')
  })

  it('falls back to remote media_url when no cached local_url exists', async () => {
    const { resolveDefaultMediaSource } = await import('../../../src/renderer/default-media-player.ts')

    const source = resolveDefaultMediaSource({
      id: 'media-1',
      name: 'Fallback',
      type: 'VIDEO',
      media_url: 'https://cdn.example.com/fallback.mp4',
    })

    expect(source).to.equal('https://cdn.example.com/fallback.mp4')
  })
})
