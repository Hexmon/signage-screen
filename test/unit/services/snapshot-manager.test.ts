/**
 * Unit tests for snapshot manager offline fallback
 */

const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const { createTempDir, cleanupTempDir } = require('../../helpers/test-utils.ts')

describe('Snapshot Manager', () => {
  let tempDir: string
  let cacheDir: string
  let sandbox: sinon.SinonSandbox
  let clock: sinon.SinonFakeTimers | undefined

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    tempDir = createTempDir('snapshot-test-')
    cacheDir = path.join(tempDir, 'cache')
    fs.mkdirSync(cacheDir, { recursive: true })

    process.env.HEXMON_CONFIG_PATH = path.join(tempDir, 'config.json')
    const testConfig = {
      apiBase: 'https://api-test.hexmon.com',
      wsUrl: 'wss://api-test.hexmon.com/ws',
      deviceId: 'device-123',
      cache: {
        path: cacheDir,
        maxBytes: 10485760,
      },
      intervals: {
        heartbeatMs: 30000,
        commandPollMs: 30000,
        schedulePollMs: 60000,
        healthCheckMs: 60000,
        screenshotMs: 300000,
      },
      mtls: {
        enabled: false,
        certPath: path.join(tempDir, 'client.crt'),
        keyPath: path.join(tempDir, 'client.key'),
        caPath: path.join(tempDir, 'ca.crt'),
      },
    }
    fs.writeFileSync(process.env.HEXMON_CONFIG_PATH, JSON.stringify(testConfig, null, 2))
  })

  afterEach(() => {
    clock?.restore()
    clock = undefined
    sandbox.restore()
    cleanupTempDir(tempDir)
    delete process.env.HEXMON_CONFIG_PATH

    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/main/services') || key.includes('src/common')) {
        delete require.cache[key]
      }
    })
  })

  it('should use offline fallback on 404', async () => {
    const mediaDir = path.join(cacheDir, 'media')
    fs.mkdirSync(mediaDir, { recursive: true })

    const snapshotFile = path.join(cacheDir, 'last-snapshot.json')
    fs.writeFileSync(
      snapshotFile,
      JSON.stringify({
        id: 'snap-1',
        schedule: {
          id: 'sched-1',
          items: [
            {
              id: 'item-1',
              media_id: 'media-1',
              display_ms: 10000,
              type: 'image',
              media_url: 'https://cdn.example.com/media-1.jpg',
            },
          ],
        },
        media_urls: {
          'media-1': 'https://cdn.example.com/media-1.jpg',
        },
      })
    )

    fs.writeFileSync(path.join(mediaDir, 'media-1.jpg'), Buffer.from('cached'))

    const { getHttpClient } = require('../../../src/main/services/network/http-client')
    const httpClient = getHttpClient()
    sandbox.stub(httpClient, 'getResponse').rejects({ response: { status: 404 } })

    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')
    const snapshotManager = getSnapshotManager()

    const playlist = await snapshotManager.refreshSnapshot()

    expect(playlist?.mode).to.equal('normal')
    expect(playlist?.items.length).to.be.greaterThan(0)
  })

  it('should locally switch from default fallback to an active schedule window when the boundary is reached', async () => {
    const baseTime = new Date('2026-03-14T09:00:00.000Z')
    clock = sandbox.useFakeTimers({ now: baseTime, shouldAdvanceTime: false })

    const mediaDir = path.join(cacheDir, 'media')
    fs.mkdirSync(mediaDir, { recursive: true })

    const snapshotFile = path.join(cacheDir, 'last-snapshot.json')
    fs.writeFileSync(
      snapshotFile,
      JSON.stringify({
        snapshot_id: 'snap-local-window',
        schedule: {
          id: 'sched-window',
          timezone: 'UTC',
          items: [
            {
              id: 'window-1',
              start_at: '2026-03-14T09:00:01.000Z',
              end_at: '2026-03-14T09:10:00.000Z',
              priority: 10,
              presentation: {
                id: 'presentation-1',
                name: 'Morning Takeover',
                items: [
                  {
                    id: 'presentation-item-1',
                    media_id: 'media-1',
                    order: 0,
                    duration_seconds: 15,
                    media: {
                      id: 'media-1',
                      name: 'Morning Asset',
                      type: 'VIDEO',
                    },
                  },
                ],
              },
            },
          ],
        },
        default_media: {
          id: 'media-default',
          type: 'image',
          display_ms: 12000,
          media_url: 'https://cdn.example.com/default.jpg',
        },
        media_urls: {
          'media-1': 'https://cdn.example.com/morning.mp4',
          'media-default': 'https://cdn.example.com/default.jpg',
        },
      }),
    )

    fs.writeFileSync(path.join(mediaDir, 'media-1.mp4'), Buffer.from('scheduled'))
    fs.writeFileSync(path.join(mediaDir, 'media-default.jpg'), Buffer.from('default'))

    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')
    const snapshotManager = getSnapshotManager()

    await clock.tickAsync(0)

    const initialPlaylist = snapshotManager.getCurrentPlaylist()
    expect(initialPlaylist?.mode).to.equal('normal')
    expect(initialPlaylist?.items).to.deep.equal([])

    await clock.tickAsync(1000)

    const transitionedPlaylist = snapshotManager.getCurrentPlaylist()
    expect(transitionedPlaylist?.mode).to.equal('normal')
    expect(transitionedPlaylist?.items[0]?.type).to.equal('video')
    expect(transitionedPlaylist?.items.map((item: any) => item.mediaId)).to.deep.equal(['media-1'])
  })

  it('should synthesize a layout scene for slot-based active schedule windows', async () => {
    const baseTime = new Date('2026-03-14T09:00:05.000Z')
    clock = sandbox.useFakeTimers({ now: baseTime, shouldAdvanceTime: false })

    const mediaDir = path.join(cacheDir, 'media')
    fs.mkdirSync(mediaDir, { recursive: true })

    const snapshotFile = path.join(cacheDir, 'last-snapshot.json')
    fs.writeFileSync(
      snapshotFile,
      JSON.stringify({
        snapshot_id: 'snap-layout-scene',
        schedule: {
          id: 'sched-layout-scene',
          items: [
            {
              id: 'window-layout-1',
              start_at: '2026-03-14T09:00:00.000Z',
              end_at: '2026-03-14T09:30:00.000Z',
              priority: 20,
              presentation: {
                id: 'presentation-layout-1',
                name: 'Lobby Wall',
                layout: {
                  id: 'layout-1',
                  name: 'Two Up',
                  aspect_ratio: '16:9',
                  spec: {
                    slots: [
                      { id: 'left', x: 0, y: 0, w: 0.5, h: 1 },
                      { id: 'right', x: 0.5, y: 0, w: 0.5, h: 1 },
                    ],
                  },
                },
                slots: [
                  {
                    id: 'slot-item-left',
                    slot_id: 'left',
                    media_id: 'media-left',
                    order: 0,
                    duration_seconds: 10,
                    fit_mode: 'contain',
                    audio_enabled: false,
                    media: {
                      id: 'media-left',
                      name: 'Left Promo',
                      type: 'IMAGE',
                    },
                  },
                  {
                    id: 'slot-item-right',
                    slot_id: 'right',
                    media_id: 'media-right',
                    order: 0,
                    duration_seconds: 12,
                    fit_mode: 'cover',
                    audio_enabled: true,
                    media: {
                      id: 'media-right',
                      name: 'Right Video',
                      type: 'VIDEO',
                    },
                  },
                ],
              },
            },
          ],
        },
        media_urls: {
          'media-left': 'https://cdn.example.com/left.jpg',
          'media-right': 'https://cdn.example.com/right.mp4',
        },
      }),
    )

    fs.writeFileSync(path.join(mediaDir, 'media-left.jpg'), Buffer.from('left'))
    fs.writeFileSync(path.join(mediaDir, 'media-right.mp4'), Buffer.from('right'))

    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')
    const snapshotManager = getSnapshotManager()

    await clock.tickAsync(0)

    const playlist = snapshotManager.getCurrentPlaylist()
    expect(playlist?.mode).to.equal('normal')
    expect(playlist?.items).to.have.length(1)
    expect(playlist?.items[0]?.type).to.equal('scene')
    expect(playlist?.items[0]?.mediaId).to.equal('media-left')
    expect((playlist?.items[0]?.meta as any)?.scene?.slots).to.have.length(2)
  })
})
