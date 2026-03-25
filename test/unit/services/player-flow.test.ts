const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const { createTempDir, cleanupTempDir } = require('../../helpers/test-utils.ts')

describe('Player Flow', () => {
  let tempDir: string
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    tempDir = createTempDir('player-flow-test-')

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

  function createCompleteBootstrapStubs() {
    const { getHttpClient } = require('../../../src/main/services/network/http-client')
    const { getHeartbeatService } = require('../../../src/main/services/telemetry/heartbeat')
    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')
    const { getPlaybackEngine } = require('../../../src/main/services/playback/playback-engine')
    const { getTelemetryService } = require('../../../src/main/services/telemetry/telemetry-service')
    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getDefaultMediaService } = require('../../../src/main/services/settings/default-media-service')

    const httpClient = getHttpClient()
    const heartbeatService = getHeartbeatService()
    const snapshotManager = getSnapshotManager()
    const playbackEngine = getPlaybackEngine()
    const telemetryService = getTelemetryService()
    const commandProcessor = getCommandProcessor()
    const defaultMediaService = getDefaultMediaService()

    sandbox.stub(httpClient, 'get').resolves({})
    sandbox.stub(heartbeatService, 'sendImmediate').resolves()
    sandbox.stub(snapshotManager, 'start').returns(undefined)
    sandbox.stub(snapshotManager, 'refreshSnapshot').resolves({ mode: 'normal', items: [], scheduleId: 'sched-1' })
    sandbox.stub(playbackEngine, 'start').resolves()
    sandbox.stub(telemetryService, 'start').resolves()
    sandbox.stub(telemetryService, 'stop').resolves()
    sandbox.stub(commandProcessor, 'start').returns()
    sandbox.stub(commandProcessor, 'stop').returns()
    sandbox.stub(defaultMediaService, 'start').returns()
    sandbox.stub(defaultMediaService, 'stop').returns()

    return {
      httpClient,
      heartbeatService,
      snapshotManager,
      playbackEngine,
      telemetryService,
      commandProcessor,
      defaultMediaService,
    }
  }

  it('should bootstrap to PAIRED_RUNTIME when stored credentials authenticate successfully', async () => {
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()
    await stateStore.update({
      deviceId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fingerprint-1',
    })

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'complete', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(true)

    const stubs = createCompleteBootstrapStubs()
    const playerFlow = getPlayerFlow()

    await playerFlow.start()

    expect(playerFlow.getState()).to.equal('PAIRED_RUNTIME')
    expect(playerFlow.getStatus().pairingCode).to.equal(undefined)
    expect(stubs.httpClient.get.calledOnce).to.equal(true)
    expect(stubs.heartbeatService.sendImmediate.calledOnce).to.equal(true)

    await playerFlow.stop()
  })

  it('should remain in HARD_RECOVERY when boot has no trustworthy credentials and fresh pairing request fails', async () => {
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')

    await getDeviceStateStore().clearIdentity()
    const pairingService = getPairingService()

    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'missing', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(false)
    sandbox.stub(pairingService, 'requestPairingCode').rejects(new Error('backend offline'))

    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    expect(playerFlow.getState()).to.equal('HARD_RECOVERY')
    await playerFlow.stop()
  })

  it('should move to RECOVERY_REQUIRED when startup finds a partial identity for a trustworthy device id', async () => {
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')

    await getDeviceStateStore().clearIdentity()
    const pairingService = getPairingService()

    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({
      health: 'partial',
      issues: ['Private key exists but certificate is missing'],
    })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(true)

    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    expect(playerFlow.getState()).to.equal('RECOVERY_REQUIRED')
    expect(playerFlow.getStatus().recoveryReason).to.include('Private key exists but certificate is missing')
    await playerFlow.stop()
  })

  it('should move to SOFT_RECOVERY on transient bootstrap failure', async () => {
    const { DeviceApiError } = require('../../../src/common/types')
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')
    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()
    await stateStore.update({
      deviceId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fingerprint-1',
    })

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'complete', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(true)

    sandbox.stub(getSnapshotManager(), 'start').returns(undefined)
    sandbox.stub(getSnapshotManager(), 'refreshSnapshot').resolves({ mode: 'offline', items: [], scheduleId: 'sched-1' })
    sandbox.stub(getHttpClient(), 'get').rejects(
      new DeviceApiError({
        code: 'NETWORK_ERROR',
        message: 'connect ETIMEDOUT',
        transient: true,
      })
    )

    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    expect(playerFlow.getState()).to.equal('SOFT_RECOVERY')
    await playerFlow.stop()
  })

  it('should move to RECOVERY_REQUIRED on bootstrap credential expiry failure', async () => {
    const { DeviceApiError } = require('../../../src/common/types')
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()
    await stateStore.update({
      deviceId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fingerprint-1',
    })

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'complete', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(true)
    sandbox.stub(getHttpClient(), 'get').rejects(
      new DeviceApiError({
        code: 'FORBIDDEN',
        status: 403,
        message: 'Device credentials expired',
      })
    )

    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    expect(playerFlow.getState()).to.equal('RECOVERY_REQUIRED')
    await playerFlow.stop()
  })

  it('should move to RECOVERY_REQUIRED on bootstrap invalid credential failure', async () => {
    const { DeviceApiError } = require('../../../src/common/types')
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()
    await stateStore.update({
      deviceId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fingerprint-1',
    })

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'complete', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(true)
    sandbox.stub(getHttpClient(), 'get').rejects(
      new DeviceApiError({
        code: 'FORBIDDEN',
        status: 403,
        message: 'Invalid device credentials',
      })
    )

    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    expect(playerFlow.getState()).to.equal('RECOVERY_REQUIRED')
    await playerFlow.stop()
  })

  it('should remain in HARD_RECOVERY when bootstrap reports device not registered and fresh pairing cannot start', async () => {
    const { DeviceApiError } = require('../../../src/common/types')
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()
    await stateStore.update({
      deviceId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fingerprint-1',
    })

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'complete', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').onFirstCall().returns(true).returns(false)
    sandbox.stub(pairingService, 'requestPairingCode').rejects(new Error('request failed'))
    sandbox.stub(getHttpClient(), 'get').rejects(
      new DeviceApiError({
        code: 'NOT_FOUND',
        status: 404,
        message: 'Device not registered',
      })
    )

    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    expect(playerFlow.getState()).to.equal('HARD_RECOVERY')
    await playerFlow.stop()
  })

  it('should complete in-place recovery on the same device id when active_pairing is RECOVERY', async () => {
    const { DeviceApiError } = require('../../../src/common/types')
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getLifecycleEvents } = require('../../../src/main/services/lifecycle-events')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()
    await stateStore.update({
      deviceId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fingerprint-1',
    })

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'complete', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(true)
    const fetchStatusStub = sandbox.stub(pairingService, 'fetchPairingStatus').resolves({
      device_id: '11111111-1111-4111-8111-111111111111',
      screen: {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'OFFLINE',
      },
      active_pairing: {
        mode: 'RECOVERY',
        confirmed: true,
        pairing_code: 'REC123',
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
    })
    const submitPairingStub = sandbox.stub(pairingService, 'submitPairing').resolves({
      success: true,
      device_id: '11111111-1111-4111-8111-111111111111',
      certificate: 'cert',
      ca_certificate: 'ca',
      fingerprint: 'fingerprint-2',
    })

    createCompleteBootstrapStubs()
    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    getLifecycleEvents().emitRuntimeAuthFailure({
      source: 'heartbeat',
      error: new DeviceApiError({
        code: 'FORBIDDEN',
        status: 403,
        message: 'Invalid device credentials',
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fetchStatusStub.called).to.equal(true)
    expect(submitPairingStub.calledOnce).to.equal(true)
    expect(playerFlow.getState()).to.equal('PAIRED_RUNTIME')
    await playerFlow.stop()
  })

  it('should stay in RECOVERY_REQUIRED with a clear reason when confirmed recovery status omits pairing_code', async () => {
    const { DeviceApiError } = require('../../../src/common/types')
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getLifecycleEvents } = require('../../../src/main/services/lifecycle-events')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()
    await stateStore.update({
      deviceId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fingerprint-1',
    })

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'complete', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(true)
    sandbox.stub(pairingService, 'fetchPairingStatus').resolves({
      device_id: '11111111-1111-4111-8111-111111111111',
      screen: {
        id: '11111111-1111-4111-8111-111111111111',
        status: 'OFFLINE',
      },
      active_pairing: {
        id: 'pairing-1',
        mode: 'RECOVERY',
        confirmed: true,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
    })
    const submitPairingStub = sandbox.stub(pairingService, 'submitPairing').resolves({
      success: true,
      device_id: '11111111-1111-4111-8111-111111111111',
      certificate: 'cert',
      ca_certificate: 'ca',
      fingerprint: 'fingerprint-2',
    })

    createCompleteBootstrapStubs()
    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    getLifecycleEvents().emitRuntimeAuthFailure({
      source: 'heartbeat',
      error: new DeviceApiError({
        code: 'FORBIDDEN',
        status: 403,
        message: 'Invalid device credentials',
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(submitPairingStub.called).to.equal(false)
    expect(playerFlow.getState()).to.equal('RECOVERY_REQUIRED')
    expect(playerFlow.getStatus().recoveryReason).to.equal(
      'Recovery confirmed, but backend did not return the recovery code yet.'
    )
    await playerFlow.stop()
  })

  it('should complete fresh pairing when active_pairing mode is PAIRING', async () => {
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'missing', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').callsFake(() => {
      const state = stateStore.getState()
      return Boolean(state.deviceId)
    })
    sandbox.stub(pairingService, 'requestPairingCode').callsFake(async () => {
      await stateStore.update({
        deviceId: '11111111-1111-4111-8111-111111111111',
        pairingCode: 'PAIR12',
        pairingExpiresAt: new Date(Date.now() + 60000).toISOString(),
        activePairingMode: 'PAIRING',
      })
      return {
        id: 'pairing-1',
        device_id: '11111111-1111-4111-8111-111111111111',
        pairing_code: 'PAIR12',
        expires_at: new Date(Date.now() + 60000).toISOString(),
        expires_in: 60,
        connected: true,
      }
    })
    sandbox.stub(pairingService, 'fetchPairingStatus').resolves({
      device_id: '11111111-1111-4111-8111-111111111111',
      screen: null,
      active_pairing: {
        mode: 'PAIRING',
        confirmed: true,
        pairing_code: 'PAIR12',
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
    })
    const submitPairingStub = sandbox.stub(pairingService, 'submitPairing').resolves({
      success: true,
      device_id: '11111111-1111-4111-8111-111111111111',
      certificate: 'cert',
      ca_certificate: 'ca',
      fingerprint: 'fingerprint-2',
    })

    createCompleteBootstrapStubs()
    const playerFlow = getPlayerFlow()
    await playerFlow.start()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(submitPairingStub.calledOnce).to.equal(true)
    expect(playerFlow.getState()).to.equal('PAIRED_RUNTIME')
    await playerFlow.stop()
  })

  it('should skip scheduled screenshot capture when the screenshot policy is disabled', async () => {
    const clock = sandbox.useFakeTimers()
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getScreenshotService } = require('../../../src/main/services/screenshot-service')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()
    await stateStore.update({
      deviceId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fingerprint-1',
    })

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'complete', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(true)

    createCompleteBootstrapStubs()
    const screenshotService = getScreenshotService()
    sandbox.stub(screenshotService, 'isCaptureEnabled').returns(false)
    const captureStub = sandbox.stub(screenshotService, 'captureAndUpload').resolves('object-key')

    const playerFlow = getPlayerFlow()
    await playerFlow.start()
    await clock.tickAsync(300000)

    expect(playerFlow.getState()).to.equal('PAIRED_RUNTIME')
    expect(captureStub.called).to.equal(false)

    await playerFlow.stop()
  })

  it('should keep runtime active when scheduled screenshot upload fails', async () => {
    const clock = sandbox.useFakeTimers()
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getScreenshotService } = require('../../../src/main/services/screenshot-service')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()
    await stateStore.update({
      deviceId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fingerprint-1',
    })

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'complete', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(true)

    createCompleteBootstrapStubs()
    const screenshotService = getScreenshotService()
    sandbox.stub(screenshotService, 'isCaptureEnabled').returns(true)
    const captureStub = sandbox.stub(screenshotService, 'captureAndUpload').rejects(new Error('upload failed'))

    const playerFlow = getPlayerFlow()
    await playerFlow.start()
    await clock.tickAsync(300000)

    expect(captureStub.calledOnce).to.equal(true)
    expect(playerFlow.getState()).to.equal('PAIRED_RUNTIME')

    await playerFlow.stop()
  })

  it('should stop timeline playback and switch status to default when fallback media is active', async () => {
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')

    const stateStore = getDeviceStateStore()
    await stateStore.clearIdentity()
    await stateStore.update({
      deviceId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'fingerprint-1',
    })

    const pairingService = getPairingService()
    sandbox.stub(pairingService, 'getStoredIdentityHealth').returns({ health: 'complete', issues: [] })
    sandbox.stub(pairingService, 'hasTrustworthyDeviceId').returns(true)

    const stubs = createCompleteBootstrapStubs()
    stubs.snapshotManager.refreshSnapshot.resolves({ mode: 'default', items: [], scheduleId: undefined })
    const playbackStopStub = sandbox.stub(stubs.playbackEngine, 'stop').returns()

    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    getSnapshotManager().emit('playlist-updated', {
      mode: 'default',
      items: [
        {
          id: 'default-item-1',
          type: 'image',
          displayMs: 10000,
          fit: 'contain',
          muted: true,
          transitionDurationMs: 0,
        },
      ],
      lastSnapshotAt: new Date().toISOString(),
    })

    expect(playerFlow.getStatus().mode).to.equal('default')
    expect(playbackStopStub.called).to.equal(true)
    expect(stubs.playbackEngine.start.called).to.equal(false)

    await playerFlow.stop()
  })
})
