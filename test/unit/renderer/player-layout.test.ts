const { expect } = require('chai')
const sinon = require('sinon')

describe('Player layout helpers', () => {
  it('computes a centered letterboxed frame for 16:9 content on a tall viewport', async () => {
    const { computeSceneStageFrame } = await import('../../../src/renderer/player.ts')

    const frame = computeSceneStageFrame('16:9', 1080, 1920)

    expect(Math.round(frame.width)).to.equal(1080)
    expect(Math.round(frame.height)).to.equal(608)
    expect(Math.round(frame.left)).to.equal(0)
    expect(Math.round(frame.top)).to.equal(656)
  })

  it('computes a centered pillarboxed frame for 9:16 content on a wide viewport', async () => {
    const { computeSceneStageFrame } = await import('../../../src/renderer/player.ts')

    const frame = computeSceneStageFrame('9:16', 1920, 1080)

    expect(Math.round(frame.width)).to.equal(608)
    expect(Math.round(frame.height)).to.equal(1080)
    expect(Math.round(frame.left)).to.equal(656)
    expect(Math.round(frame.top)).to.equal(0)
  })

  it('switches to default content when player status mode is default', async () => {
    const { resolvePlayerContentSource } = await import('../../../src/renderer/player.ts')

    const source = resolvePlayerContentSource({
      state: 'PAIRED_RUNTIME',
      mode: 'default',
      online: true,
    })

    expect(source).to.equal('default')
  })

  it('keeps schedule content active when scheduled playback is selected before current item metadata arrives', async () => {
    const { resolvePlayerContentSource } = await import('../../../src/renderer/player.ts')

    const source = resolvePlayerContentSource({
      state: 'PAIRED_RUNTIME',
      mode: 'normal',
      online: true,
    })

    expect(source).to.equal('schedule')
  })

  it('uses manual replay for loop-enabled scheduled videos', async () => {
    const { shouldUseManualVideoReplay } = await import('../../../src/renderer/player.ts')

    expect(
      shouldUseManualVideoReplay({
        id: 'video-1',
        type: 'video',
        displayMs: 30000,
        fit: 'cover',
        muted: true,
        loop: true,
        transitionDurationMs: 0,
      }),
    ).to.equal(true)

    expect(
      shouldUseManualVideoReplay({
        id: 'video-2',
        type: 'video',
        displayMs: 30000,
        fit: 'cover',
        muted: true,
        loop: false,
        transitionDurationMs: 0,
      }),
    ).to.equal(false)
  })

  it('clears scheduled playback only when player falls back to non-scheduled modes', async () => {
    const { shouldClearScheduledPlayback } = await import('../../../src/renderer/player.ts')

    expect(
      shouldClearScheduledPlayback({
        state: 'PAIRED_RUNTIME',
        mode: 'default',
        online: true,
      }),
    ).to.equal(true)

    expect(
      shouldClearScheduledPlayback({
        state: 'PAIRED_RUNTIME',
        mode: 'empty',
        online: true,
      }),
    ).to.equal(true)

    expect(
      shouldClearScheduledPlayback({
        state: 'PAIRED_RUNTIME',
        mode: 'normal',
        online: true,
      }),
    ).to.equal(false)

    expect(
      shouldClearScheduledPlayback({
        state: 'PAIRED_RUNTIME',
        mode: 'normal',
        online: true,
        currentMediaId: 'media-1',
      }),
    ).to.equal(false)
  })

  it('recursively tears down scheduled media trees', async () => {
    const { teardownScheduledElementTree } = await import('../../../src/renderer/player.ts')

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
      src: 'https://example.com/embed',
    }

    const rootNode = {
      querySelectorAll: sinon.stub().returns([videoNode, iframeNode]),
      parentElement: rootParent,
    }

    teardownScheduledElementTree(rootNode)

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
