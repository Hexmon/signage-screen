const { expect } = require('chai')
const sinon = require('sinon')

describe('Playback Engine', () => {
  let sandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()

    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/main/services/playback') || key.includes('src/main/services/snapshot-manager')) {
        delete require.cache[key]
      }
    })
  })

  afterEach(() => {
    sandbox.restore()

    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/main/services/playback') || key.includes('src/main/services/snapshot-manager')) {
        delete require.cache[key]
      }
    })
  })

  it('emits a clear-active playback update when playback stops', () => {
    const { getPlaybackEngine } = require('../../../src/main/services/playback/playback-engine')

    const send = sandbox.spy()
    const engine = getPlaybackEngine()
    engine.initialize({
      webContents: {
        send,
      },
    })

    engine.stop()

    expect(send.calledWith('playback-update', {
      type: 'clear-active',
      reason: 'timeline-stopped',
    })).to.equal(true)
  })
})
