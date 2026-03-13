const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const { createTempDir, cleanupTempDir } = require('../../helpers/test-utils.ts')

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Default Media Service', () => {
  let tempDir
  let sandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    tempDir = createTempDir('default-media-service-test-')

    process.env.HEXMON_CONFIG_PATH = path.join(tempDir, 'config.json')
    const testConfig = {
      apiBase: 'https://api-test.hexmon.com',
      wsUrl: 'wss://api-test.hexmon.com/ws',
      deviceId: '',
      mtls: {
        enabled: false,
        certPath: path.join(tempDir, 'client.crt'),
        keyPath: path.join(tempDir, 'client.key'),
        caPath: path.join(tempDir, 'ca.crt'),
      },
      cache: {
        path: path.join(tempDir, 'cache'),
        maxBytes: 10485760,
      },
      intervals: {
        heartbeatMs: 30000,
        commandPollMs: 30000,
        schedulePollMs: 60000,
        healthCheckMs: 60000,
        screenshotMs: 300000,
        defaultMediaPollMs: 300000,
      },
    }
    fs.writeFileSync(process.env.HEXMON_CONFIG_PATH, JSON.stringify(testConfig, null, 2))

    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/main/services') || key.includes('src/common')) {
        delete require.cache[key]
      }
    })
  })

  afterEach(() => {
    sandbox.restore()
    cleanupTempDir(tempDir)
    delete process.env.HEXMON_CONFIG_PATH

    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/main/services') || key.includes('src/common')) {
        delete require.cache[key]
      }
    })
  })

  it('fetches resolved default media for the paired device and updates the cache', async () => {
    const { DefaultMediaService } = require('../../../src/main/services/settings/default-media-service.ts')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getSettingsClient } = require('../../../src/main/services/settings/settings-client')
    const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')

    const pairingService = getPairingService()
    const settingsClient = getSettingsClient()
    const cacheManager = getCacheManager()
    const cachedPath = path.join(tempDir, 'cache', 'media', 'media-16-9.mp4')

    sandbox.stub(pairingService, 'isPairedDevice').returns(true)
    sandbox.stub(pairingService, 'getDeviceId').returns('device-123')
    const addStub = sandbox.stub(cacheManager, 'add').resolves()
    const getStub = sandbox.stub(cacheManager, 'get').resolves(cachedPath)
    const getDefaultMediaStub = sandbox.stub(settingsClient, 'getDefaultMedia').resolves({
      source: 'ASPECT_RATIO',
      aspect_ratio: '16:9',
      media_id: 'media-16-9',
      media: {
        id: 'media-16-9',
        name: 'Lobby Loop',
        type: 'VIDEO',
        media_url: 'https://cdn.example.com/lobby-loop.mp4',
        source_content_type: 'video/mp4',
      },
    })

    const service = new DefaultMediaService()
    const changedSpy = sandbox.spy()
    service.on('changed', changedSpy)

    const result = await service.refreshNow('manual')

    expect(getDefaultMediaStub.calledOnceWithExactly('device-123')).to.equal(true)
    expect(addStub.calledOnceWithExactly('media-16-9', 'https://cdn.example.com/lobby-loop.mp4')).to.equal(true)
    expect(getStub.calledWith('media-16-9')).to.equal(true)
    expect(result.source).to.equal('ASPECT_RATIO')
    expect(result.aspect_ratio).to.equal('16:9')
    expect(result.media_id).to.equal('media-16-9')
    expect(result.media.local_path).to.equal(cachedPath)
    expect(result.media.local_url).to.equal(`file://${cachedPath}`)
    expect(changedSpy.calledOnce).to.equal(true)
    expect(service.getCurrent().media_id).to.equal('media-16-9')
  })

  it('loads cached resolved default media and keeps it when refresh fails', async () => {
    const cacheDir = path.join(tempDir, 'cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(
      path.join(cacheDir, 'default-media.json'),
      JSON.stringify({
        source: 'GLOBAL',
        aspect_ratio: null,
        media_id: 'media-global',
        media: {
          id: 'media-global',
          name: 'Global Fallback',
          type: 'IMAGE',
          media_url: 'https://cdn.example.com/global-fallback.png',
          source_content_type: 'image/png',
        },
      })
    )

    const { DefaultMediaService } = require('../../../src/main/services/settings/default-media-service.ts')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getSettingsClient } = require('../../../src/main/services/settings/settings-client')
    const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')

    const pairingService = getPairingService()
    const settingsClient = getSettingsClient()
    const cacheManager = getCacheManager()
    const cachedMediaPath = path.join(cacheDir, 'media-global.png')

    sandbox.stub(pairingService, 'isPairedDevice').returns(true)
    sandbox.stub(pairingService, 'getDeviceId').returns('device-123')
    sandbox.stub(cacheManager, 'get').resolves(cachedMediaPath)
    sandbox.stub(settingsClient, 'getDefaultMedia').rejects(new Error('backend unavailable'))

    const service = new DefaultMediaService()
    await flushAsync()

    expect(service.getCurrent().media_id).to.equal('media-global')
    expect(service.getCurrent().media.local_path).to.equal(cachedMediaPath)
    expect(service.getCurrent().media.local_url).to.equal(`file://${cachedMediaPath}`)

    const result = await service.refreshNow('poll')

    expect(result.source).to.equal('GLOBAL')
    expect(result.media_id).to.equal('media-global')
    expect(service.getCurrent().media_id).to.equal('media-global')
  })

  it('skips resolved fallback fetch when the player is not paired', async () => {
    const { DefaultMediaService } = require('../../../src/main/services/settings/default-media-service.ts')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getSettingsClient } = require('../../../src/main/services/settings/settings-client')

    const pairingService = getPairingService()
    const settingsClient = getSettingsClient()

    sandbox.stub(pairingService, 'isPairedDevice').returns(false)
    sandbox.stub(pairingService, 'getDeviceId').returns(null)
    const getDefaultMediaStub = sandbox.stub(settingsClient, 'getDefaultMedia').resolves({
      source: 'NONE',
      aspect_ratio: null,
      media_id: null,
      media: null,
    })

    const service = new DefaultMediaService()
    const result = await service.refreshNow('manual')

    expect(getDefaultMediaStub.called).to.equal(false)
    expect(result.source).to.equal('NONE')
    expect(result.media_id).to.equal(null)
  })
})
