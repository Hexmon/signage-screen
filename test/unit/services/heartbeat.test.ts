const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const { createTempDir, cleanupTempDir } = require('../../helpers/test-utils.ts')

describe('Heartbeat Service', () => {
  let tempDir
  let sandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    tempDir = createTempDir('heartbeat-test-')

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

  it('sends expanded system resource metrics in the heartbeat payload', async () => {
    const { getHeartbeatService } = require('../../../src/main/services/telemetry/heartbeat')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')
    const { getSystemStatsCollector } = require('../../../src/main/services/telemetry/system-stats')
    const { getPairingService } = require('../../../src/main/services/pairing-service')
    const { getCommandProcessor } = require('../../../src/main/services/command-processor')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getPlayerMetrics } = require('../../../src/main/services/telemetry/player-metrics')

    const heartbeatService = getHeartbeatService()
    const httpClient = getHttpClient()
    const statsCollector = getSystemStatsCollector()
    const pairingService = getPairingService()
    const commandProcessor = getCommandProcessor()
    const deviceStateStore = getDeviceStateStore()

    sandbox.stub(pairingService, 'isPairedDevice').returns(true)
    sandbox.stub(pairingService, 'getDeviceId').returns('device-123')
    sandbox.stub(statsCollector, 'collect').resolves({
      cpuUsage: 37.25,
      cpuCores: 8,
      cpuLoad1m: 1.25,
      cpuLoad5m: 1.5,
      cpuLoad15m: 1.75,
      memoryUsage: 4 * 1024 * 1024 * 1024,
      memoryTotal: 8 * 1024 * 1024 * 1024,
      memoryFree: 4 * 1024 * 1024 * 1024,
      diskUsage: 100 * 1024 * 1024 * 1024,
      diskTotal: 200 * 1024 * 1024 * 1024,
      diskFree: 100 * 1024 * 1024 * 1024,
      temperature: 62.4,
      uptime: 7200,
      networkInterfaces: [],
      primaryNetworkInterface: 'eth0',
      primaryNetworkAddress: '10.20.0.20',
      displayCount: 2,
      displays: [
        {
          id: '1',
          width: 1920,
          height: 1080,
          refresh_rate_hz: 60,
          orientation: 'landscape',
          connected: true,
          model: 'Display 1',
        },
        {
          id: '2',
          width: 1080,
          height: 1920,
          refresh_rate_hz: 60,
          orientation: 'portrait',
          connected: true,
          model: 'Display 2',
        },
      ],
      hostname: 'player-host',
      osVersion: 'linux 6.8.0',
      batteryPercent: 84,
      isCharging: true,
      powerSource: 'AC',
    })

    const postStub = sandbox.stub(httpClient, 'post').resolves({ success: true, timestamp: new Date().toISOString(), commands: [] })
    sandbox.stub(commandProcessor, 'ingestCommands').resolves()
    const updateStub = sandbox.stub(deviceStateStore, 'update').resolves()

    heartbeatService.setCurrentSchedule('schedule-1')
    heartbeatService.setCurrentMedia('media-1')

    await heartbeatService.sendImmediate()
    const metrics = await getPlayerMetrics().renderPrometheusMetrics(async () => await statsCollector.collect())

    expect(postStub.calledOnce).to.equal(true)
    const payload = postStub.firstCall.args[1]
    expect(payload).to.include({
      device_id: 'device-123',
      status: 'ONLINE',
      uptime: 7200,
      memory_usage: 50,
      cpu_usage: 37.25,
      current_schedule_id: 'schedule-1',
      current_media_id: 'media-1',
      memory_total_mb: 8192,
      memory_used_mb: 4096,
      memory_free_mb: 4096,
      cpu_cores: 8,
      cpu_load_1m: 1.25,
      cpu_load_5m: 1.5,
      cpu_load_15m: 1.75,
      cpu_temp_c: 62.4,
      disk_total_gb: 200,
      disk_used_gb: 100,
      disk_free_gb: 100,
      disk_usage_percent: 50,
      network_ip: '10.20.0.20',
      network_interface: 'eth0',
      display_count: 2,
      os_version: 'linux 6.8.0',
      hostname: 'player-host',
      battery_percent: 84,
      is_charging: true,
      power_source: 'AC',
    })
    expect(payload.displays).to.deep.equal([
      {
        id: '1',
        width: 1920,
        height: 1080,
        refresh_rate_hz: 60,
        orientation: 'landscape',
        connected: true,
        model: 'Display 1',
      },
      {
        id: '2',
        width: 1080,
        height: 1920,
        refresh_rate_hz: 60,
        orientation: 'portrait',
        connected: true,
        model: 'Display 2',
      },
    ])
    expect(payload.player_uptime_seconds).to.be.a('number')
    expect(payload.player_uptime_seconds).to.be.greaterThan(0)
    expect(updateStub.calledOnce).to.equal(true)
    expect(metrics).to.contain('signhex_player_heartbeat_total{result="success"} 1')
    expect(metrics).to.contain('signhex_player_last_successful_heartbeat_unixtime')
  })
})
