const { expect } = require('chai')

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
})
