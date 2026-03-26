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

  it('ignores equivalent timeline playlist updates when only presigned asset urls changed', async () => {
    const { getPlaybackEngine } = require('../../../src/main/services/playback/playback-engine')
    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')

    const engine = getPlaybackEngine()
    sandbox.stub(engine, 'stop')
    const startPlaylistStub = sandbox.stub(engine, 'startPlaylist').resolves()

    const basePlaylist = {
      mode: 'emergency',
      scheduleId: 'schedule-1',
      snapshotId: 'snapshot-1',
      items: [
        {
          id: 'item-1',
          type: 'url',
          mediaId: 'media-1',
          remoteUrl: 'https://status.example.com/dashboard?view=ops',
          displayMs: 10000,
          fit: 'contain',
          muted: true,
          loop: false,
          transitionDurationMs: 0,
          meta: {
            source_url: 'https://status.example.com/dashboard?view=ops',
            fallback_url: 'https://cdn.example.com/webpage-fallback.png?X-Amz-Signature=one',
          },
        },
      ],
    }

    engine.state = 'emergency'
    engine.currentTimelineFingerprint = engine.fingerprintPlaylist(basePlaylist)

    getSnapshotManager().emit('playlist-updated', {
      ...basePlaylist,
      snapshotId: 'snapshot-2',
      items: [
        {
          ...basePlaylist.items[0],
          meta: {
            ...basePlaylist.items[0].meta,
            fallback_url: 'https://cdn.example.com/webpage-fallback.png?X-Amz-Signature=two',
          },
        },
      ],
    })

    await Promise.resolve()

    expect(engine.stop.called).to.equal(false)
    expect(startPlaylistStub.called).to.equal(false)
  })
})
