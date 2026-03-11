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

    const commandProcessor = getCommandProcessor()
    const snapshotManager = getSnapshotManager()
    const httpClient = getHttpClient()

    const refreshStub = sandbox.stub(snapshotManager, 'refreshSnapshot').resolves({ mode: 'normal', items: [], scheduleId: 'sched-1' })
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
  })

  it('should persist recent command ledger entries for restart safety', async () => {
    const { resetDeviceStateStore, getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    resetDeviceStateStore()
    await getDeviceStateStore().clearIdentity()

    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')

    const commandProcessor = getCommandProcessor()
    const snapshotManager = getSnapshotManager()
    const httpClient = getHttpClient()

    sandbox.stub(snapshotManager, 'refreshSnapshot').resolves({ mode: 'normal', items: [], scheduleId: 'sched-1' })
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
})
