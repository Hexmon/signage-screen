/**
 * Unit tests for player flow state transitions
 */

import { expect } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as sinon from 'sinon'
import { createTempDir, cleanupTempDir } from '../../helpers/test-utils.ts'

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

  it('should move to NEED_PAIRING when no device/cert is present', async () => {
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getCertificateManager } = require('../../../src/main/services/cert-manager')

    const pairingService = getPairingService()
    const certManager = getCertificateManager()

    sandbox.stub(pairingService, 'getDeviceId').returns('')
    sandbox.stub(certManager, 'areCertificatesPresent').returns(false)

    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    expect(playerFlow.getState()).to.equal('NEED_PAIRING')
  })

  it('should move to PLAYBACK_RUNNING when device and cert are present', async () => {
    const { getPlayerFlow } = require('../../../src/main/services/player-flow')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getCertificateManager } = require('../../../src/main/services/cert-manager')
    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')
    const { getPlaybackEngine } = require('../../../src/main/services/playback/playback-engine')
    const { getTelemetryService } = require('../../../src/main/services/telemetry/telemetry-service')
    const { getCommandProcessor } = require('../../../src/main/services/command-processor')

    const pairingService = getPairingService()
    const certManager = getCertificateManager()
    const snapshotManager = getSnapshotManager()
    const playbackEngine = getPlaybackEngine()
    const telemetryService = getTelemetryService()
    const commandProcessor = getCommandProcessor()

    sandbox.stub(pairingService, 'getDeviceId').returns('device-1')
    sandbox.stub(certManager, 'areCertificatesPresent').returns(true)
    sandbox.stub(snapshotManager, 'start').returns(undefined)
    sandbox.stub(snapshotManager, 'refreshSnapshot').resolves({ mode: 'normal', items: [], scheduleId: 'sched-1' })
    sandbox.stub(playbackEngine, 'start').resolves()
    sandbox.stub(telemetryService, 'start').resolves()
    sandbox.stub(commandProcessor, 'start').returns()

    const playerFlow = getPlayerFlow()
    await playerFlow.start()

    expect(playerFlow.getState()).to.equal('PLAYBACK_RUNNING')

    await playerFlow.stop()
  })
})
