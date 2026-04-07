const { expect } = require('chai')

describe('Webpage playback helpers', () => {
  it('does not reveal the live page for an empty SPA shell', async () => {
    const { shouldRevealLiveWebpage } = await import('../../../src/renderer/webpage-playback.ts')

    const ready = shouldRevealLiveWebpage({
      width: 1280,
      height: 720,
      textLength: 0,
      mediaCount: 0,
      visibleElementCount: 1,
    })

    expect(ready).to.equal(false)
  })

  it('reveals the live page once visible rendered content exists', async () => {
    const { shouldRevealLiveWebpage } = await import('../../../src/renderer/webpage-playback.ts')

    const ready = shouldRevealLiveWebpage({
      width: 1280,
      height: 720,
      textLength: 56,
      mediaCount: 0,
      visibleElementCount: 3,
    })

    expect(ready).to.equal(true)
  })
})
