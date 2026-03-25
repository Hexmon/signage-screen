const { expect } = require('chai')
const sinon = require('sinon')

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

  it('recursively tears down hidden default-media trees', async () => {
    const { teardownDefaultMediaElementTree } = await import('../../../src/renderer/default-media-player.ts')

    const videoParent = { removeChild: sinon.spy() }
    const iframeParent = { removeChild: sinon.spy() }
    const rootParent = { removeChild: sinon.spy() }

    const videoNode = {
      pause: sinon.spy(),
      removeAttribute: sinon.spy(),
      load: sinon.spy(),
      parentElement: videoParent,
    }

    const iframeNode = {
      removeAttribute: sinon.spy(),
      parentElement: iframeParent,
      src: 'https://example.com/default.pdf',
    }

    const rootNode = {
      querySelectorAll: sinon.stub().returns([videoNode, iframeNode]),
      parentElement: rootParent,
    }

    teardownDefaultMediaElementTree(rootNode)

    expect(videoNode.pause.calledOnce).to.equal(true)
    expect(videoNode.removeAttribute.calledWith('src')).to.equal(true)
    expect(videoNode.load.calledOnce).to.equal(true)
    expect(videoParent.removeChild.calledWith(videoNode)).to.equal(true)

    expect(iframeNode.removeAttribute.calledWith('src')).to.equal(true)
    expect(iframeNode.src).to.equal('')
    expect(iframeParent.removeChild.calledWith(iframeNode)).to.equal(true)

    expect(rootParent.removeChild.calledWith(rootNode)).to.equal(true)
  })
})
