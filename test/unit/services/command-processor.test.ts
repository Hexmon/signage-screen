const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const { createTempDir, cleanupTempDir } = require('../../helpers/test-utils.ts')

describe('Command Processor', () => {
  let tempDir: string
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    tempDir = createTempDir('command-processor-test-')

    process.env.HEXMON_CONFIG_PATH = path.join(tempDir, 'config.json')
    fs.writeFileSync(
      process.env.HEXMON_CONFIG_PATH,
      JSON.stringify(
        {
          apiBase: 'https://api-test.hexmon.com',
          wsUrl: 'wss://api-test.hexmon.com/ws',
          deviceId: 'device-1',
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
            defaultMediaPollMs: 60000,
            healthCheckMs: 60000,
            screenshotMs: 300000,
          },
        },
        null,
        2
      )
    )

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

  it('should dedupe commands across heartbeat and poll sources', async () => {
    const { resetDeviceStateStore, getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    resetDeviceStateStore()
    await getDeviceStateStore().clearIdentity()

    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')
    const { getDefaultMediaService } = require('../../../src/main/services/settings/default-media-service')

    const commandProcessor = getCommandProcessor()
    const snapshotManager = getSnapshotManager()
    const httpClient = getHttpClient()
    const defaultMediaService = getDefaultMediaService()

    const refreshStub = sandbox.stub(snapshotManager, 'refreshSnapshot').resolves({ mode: 'normal', items: [], scheduleId: 'sched-1' })
    const defaultRefreshStub = sandbox.stub(defaultMediaService, 'refreshNow').resolves({
      source: 'NONE',
      aspect_ratio: null,
      media_id: null,
      media: null,
    })
    sandbox.stub(httpClient, 'post').resolves({ success: true, timestamp: new Date().toISOString() })

    const command = {
      id: 'cmd-1',
      type: 'REFRESH',
      payload: {
        reason: 'publish',
      },
    }

    await commandProcessor.ingestCommands([command], 'heartbeat')
    await commandProcessor.ingestCommands([command], 'poll')

    expect(refreshStub.calledOnce).to.be.true
    expect(defaultRefreshStub.calledOnceWithExactly('refresh-command')).to.be.true
  })

  it('should process consecutive refresh commands without rate limiting default media updates', async () => {
    const { resetDeviceStateStore, getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    resetDeviceStateStore()
    await getDeviceStateStore().clearIdentity()

    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')
    const { getDefaultMediaService } = require('../../../src/main/services/settings/default-media-service')

    const commandProcessor = getCommandProcessor()
    const snapshotManager = getSnapshotManager()
    const httpClient = getHttpClient()
    const defaultMediaService = getDefaultMediaService()

    const refreshStub = sandbox.stub(snapshotManager, 'refreshSnapshot').resolves({ mode: 'empty', items: [], scheduleId: undefined })
    const defaultRefreshStub = sandbox.stub(defaultMediaService, 'refreshNow').resolves({
      source: 'NONE',
      aspect_ratio: null,
      media_id: null,
      media: null,
    })
    sandbox.stub(httpClient, 'post').resolves({ success: true, timestamp: new Date().toISOString() })

    await commandProcessor.ingestCommands(
      [
        {
          id: 'cmd-refresh-1',
          type: 'REFRESH',
          payload: { reason: 'DEFAULT_MEDIA' },
        },
        {
          id: 'cmd-refresh-2',
          type: 'REFRESH',
          payload: { reason: 'DEFAULT_MEDIA' },
        },
      ],
      'poll'
    )

    expect(refreshStub.callCount).to.equal(2)
    expect(defaultRefreshStub.callCount).to.equal(2)
  })

  it('should persist recent command ledger entries for restart safety', async () => {
    const { resetDeviceStateStore, getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    resetDeviceStateStore()
    await getDeviceStateStore().clearIdentity()

    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')
    const { getDefaultMediaService } = require('../../../src/main/services/settings/default-media-service')

    const commandProcessor = getCommandProcessor()
    const snapshotManager = getSnapshotManager()
    const httpClient = getHttpClient()
    const defaultMediaService = getDefaultMediaService()

    sandbox.stub(snapshotManager, 'refreshSnapshot').resolves({ mode: 'normal', items: [], scheduleId: 'sched-1' })
    sandbox.stub(defaultMediaService, 'refreshNow').resolves({
      source: 'NONE',
      aspect_ratio: null,
      media_id: null,
      media: null,
    })
    sandbox.stub(httpClient, 'post').resolves({ success: true, timestamp: new Date().toISOString() })

    await commandProcessor.ingestCommands(
      [
        {
          id: 'cmd-2',
          type: 'REFRESH',
        },
      ],
      'heartbeat'
    )

    const store = getDeviceStateStore()
    expect(store.hasRecentCommand('cmd-2')).to.equal(true)
  })

  it('should apply screenshot interval commands using interval_seconds and enable capture', async () => {
    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getConfigManager } = require('../../../src/common/config')
    const { getScreenshotService } = require('../../../src/main/services/screenshot-service')

    const commandProcessor = getCommandProcessor()
    const screenshotService = getScreenshotService()
    const applyPolicySpy = sandbox.spy(screenshotService, 'applyPolicy')

    const result = await commandProcessor.handleSetScreenshotInterval({
      id: 'cmd-interval',
      type: 'SET_SCREENSHOT_INTERVAL',
      params: {
        interval_seconds: 30,
        enabled: true,
      },
    })

    expect(result.success).to.equal(true)
    expect(applyPolicySpy.calledOnceWith({
      enabled: true,
      interval_seconds: 30,
      interval_ms: null,
    })).to.equal(true)
    expect(getConfigManager().getConfig().intervals.screenshotMs).to.equal(30000)
  })

  it('should disable scheduled screenshot capture without requiring an interval', async () => {
    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getConfigManager } = require('../../../src/common/config')
    const { getScreenshotService } = require('../../../src/main/services/screenshot-service')

    const commandProcessor = getCommandProcessor()
    const screenshotService = getScreenshotService()
    const applyPolicySpy = sandbox.spy(screenshotService, 'applyPolicy')

    const originalInterval = getConfigManager().getConfig().intervals.screenshotMs
    const result = await commandProcessor.handleSetScreenshotInterval({
      id: 'cmd-disable',
      type: 'SET_SCREENSHOT_INTERVAL',
      params: {
        enabled: false,
      },
    })

    expect(result.success).to.equal(true)
    expect(result.message).to.contain('disabled')
    expect(applyPolicySpy.calledOnceWith({
      enabled: false,
      interval_seconds: null,
      interval_ms: null,
    })).to.equal(true)
    expect(getConfigManager().getConfig().intervals.screenshotMs).to.equal(originalInterval)
  })

  it('should skip /commands polling while heartbeat is still healthy', async () => {
    const clock = sandbox.useFakeTimers({
      now: new Date('2026-04-07T10:00:00.000Z'),
      shouldAdvanceTime: false,
    })
    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')

    await getDeviceStateStore().update({
      lastHeartbeatAt: new Date('2026-04-07T09:59:59.000Z').toISOString(),
    })

    const commandProcessor = getCommandProcessor()
    const httpClient = getHttpClient()
    const getStub = sandbox.stub(httpClient, 'get').resolves({ commands: [] })

    commandProcessor.start()
    await clock.tickAsync(58999)

    expect(getStub.called).to.equal(false)

    commandProcessor.stop()
  })

  it('should keep lightweight /commands polling active for passive playback while heartbeat is healthy', async () => {
    const clock = sandbox.useFakeTimers({
      now: new Date('2026-04-07T10:00:00.000Z'),
      shouldAdvanceTime: false,
    })
    sandbox.stub(Math, 'random').returns(0.5)
    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getConfigManager } = require('../../../src/common/config')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')

    await getDeviceStateStore().update({
      lastHeartbeatAt: new Date('2026-04-07T09:59:59.000Z').toISOString(),
    })

    const commandProcessor = getCommandProcessor()
    const snapshotManager = getSnapshotManager()
    sandbox.stub(snapshotManager, 'getCurrentPlaylist').returns({
      mode: 'empty',
      items: [],
      scheduleId: undefined,
    })
    const pollStub = sandbox.stub(commandProcessor as any, 'pollCommands').resolves()
    const passivePollDelayMs = getConfigManager().getConfig().intervals.commandPollMs

    commandProcessor.start()
    await clock.tickAsync(0)
    expect(pollStub.callCount).to.equal(1)

    await clock.tickAsync(passivePollDelayMs - 1)
    expect(pollStub.callCount).to.equal(1)

    await clock.tickAsync(1)
    expect(pollStub.callCount).to.equal(2)

    commandProcessor.stop()
  })

  it('should switch to fallback polling once heartbeat becomes stale', async () => {
    const clock = sandbox.useFakeTimers({
      now: new Date('2026-04-07T10:00:00.000Z'),
      shouldAdvanceTime: false,
    })
    sandbox.stub(Math, 'random').returns(0.5)
    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')

    await getDeviceStateStore().update({
      lastHeartbeatAt: new Date('2026-04-07T09:59:59.000Z').toISOString(),
    })

    const commandProcessor = getCommandProcessor()
    const httpClient = getHttpClient()
    const getStub = sandbox.stub(httpClient, 'get').resolves({ commands: [] })

    commandProcessor.start()
    await clock.tickAsync(60000)

    expect(getStub.callCount).to.equal(1)

    commandProcessor.stop()
  })

  it('should back off fallback polling after poll failures', async () => {
    const clock = sandbox.useFakeTimers({
      now: new Date('2026-04-07T10:00:00.000Z'),
      shouldAdvanceTime: false,
    })
    sandbox.stub(Math, 'random').returns(0.5)
    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')

    await getDeviceStateStore().update({
      lastHeartbeatAt: new Date('2026-04-07T09:58:00.000Z').toISOString(),
    })

    const commandProcessor = getCommandProcessor()
    const httpClient = getHttpClient()
    const getStub = sandbox.stub(httpClient, 'get')
    getStub.onFirstCall().rejects(new Error('poll failed'))
    getStub.onSecondCall().rejects(new Error('poll failed again'))
    getStub.onThirdCall().resolves({ commands: [] })

    commandProcessor.start()
    await clock.tickAsync(0)
    expect(getStub.callCount).to.equal(1)

    await clock.tickAsync(4999)
    expect(getStub.callCount).to.equal(1)

    await clock.tickAsync(1)
    expect(getStub.callCount).to.equal(2)

    await clock.tickAsync(9999)
    expect(getStub.callCount).to.equal(2)

    await clock.tickAsync(1)
    expect(getStub.callCount).to.equal(3)

    commandProcessor.stop()
  })
})
