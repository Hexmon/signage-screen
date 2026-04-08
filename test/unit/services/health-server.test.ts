const { expect } = require('chai')
const fs = require('fs')
const http = require('http')
const path = require('path')
const sinon = require('sinon')
const { createTempDir, cleanupTempDir } = require('../../helpers/test-utils.ts')

describe('Health Server', () => {
  let tempDir: string
  let sandbox: sinon.SinonSandbox
  let healthServer: any

  function resetModules() {
    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/main/services') || key.includes('src/common')) {
        delete require.cache[key]
      }
    })
  }

  function writeConfig(overrides = {}) {
    const configPath = path.join(tempDir, 'config.json')
    const config = {
      apiBase: 'https://api-test.hexmon.com',
      wsUrl: 'wss://api-test.hexmon.com/ws',
      deviceId: 'health-device',
      cache: {
        path: path.join(tempDir, 'cache'),
        maxBytes: 10485760,
      },
      intervals: {
        heartbeatMs: 30000,
        commandPollMs: 5000,
        schedulePollMs: 60000,
        defaultMediaPollMs: 60000,
        healthCheckMs: 60000,
        screenshotMs: 300000,
      },
      observability: {
        enabled: true,
        metricsEnabled: true,
        bindAddress: '127.0.0.1',
        port: 33301,
        allowRemoteAccess: false,
      },
      ...overrides,
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    process.env.HEXMON_CONFIG_PATH = configPath
  }

  function httpGet(url: string): Promise<{ statusCode?: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          })
        })
      })
      req.on('error', reject)
    })
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    tempDir = createTempDir('health-server-test-')
    writeConfig()
    resetModules()
  })

  afterEach(async () => {
    if (healthServer) {
      healthServer.stop()
      healthServer = null
    }

    try {
      const { getRequestQueue } = require('../../../src/main/services/network/request-queue')
      await getRequestQueue().cleanup()
    } catch {
      // ignore cleanup failures during module reset
    }

    sandbox.restore()
    delete process.env.HEXMON_CONFIG_PATH
    cleanupTempDir(tempDir)
    resetModules()
  })

  it('serves Prometheus metrics from the maintainable player registry', async () => {
    const { HealthServer } = require('../../../src/main/services/telemetry/health-server')
    const { getSystemStatsCollector } = require('../../../src/main/services/telemetry/system-stats')
    const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
    const { getRequestQueue } = require('../../../src/main/services/network/request-queue')
    const { getPlayerMetrics } = require('../../../src/main/services/telemetry/player-metrics')

    const statsCollector = getSystemStatsCollector()
    const cacheManager = getCacheManager()
    const requestQueue = getRequestQueue()
    const playerMetrics = getPlayerMetrics()

    sandbox.stub(statsCollector, 'collect').resolves({
      cpuUsage: 12.5,
      cpuCores: 4,
      cpuLoad1m: 0.5,
      cpuLoad5m: 0.4,
      cpuLoad15m: 0.3,
      memoryUsage: 1024,
      memoryTotal: 4096,
      memoryFree: 3072,
      diskUsage: 2048,
      diskTotal: 8192,
      diskFree: 6144,
      temperature: 55,
      uptime: 7200,
      networkInterfaces: [],
      displayCount: 2,
      displays: [],
      hostname: 'player-host',
      osVersion: 'linux',
      batteryPercent: 80,
      isCharging: true,
      powerSource: 'AC',
    })
    sandbox.stub(cacheManager, 'getStats').resolves({
      totalBytes: 1000,
      usedBytes: 400,
      freeBytes: 600,
      entryCount: 4,
      quarantinedCount: 1,
      usagePercent: 40,
      itemCount: 4,
    })
    sandbox.stub(requestQueue, 'getStats').returns({
      pendingItems: 2,
      pendingBytes: 128,
      dropped: 0,
      droppedBytes: 0,
      compacted: 0,
      compactedBytes: 0,
      categories: {
        heartbeat: { pendingItems: 1, pendingBytes: 64, dropped: 0, compacted: 0 },
        screenshot: { pendingItems: 1, pendingBytes: 64, dropped: 0, compacted: 0 },
        'command-ack': { pendingItems: 0, pendingBytes: 0, dropped: 0, compacted: 0 },
        default: { pendingItems: 0, pendingBytes: 0, dropped: 0, compacted: 0 },
      },
    })
    sandbox.stub(requestQueue, 'getQueue').returns([
      {
        id: 'req-1',
        method: 'POST',
        url: '/api/v1/device/heartbeat',
        timestamp: Date.now() - 5000,
        retries: 0,
        maxRetries: 3,
        sizeBytes: 64,
        category: 'heartbeat',
      },
      {
        id: 'req-2',
        method: 'POST',
        url: '/api/v1/device/screenshot',
        timestamp: Date.now() - 10000,
        retries: 0,
        maxRetries: 3,
        sizeBytes: 64,
        category: 'screenshot',
      },
    ])

    playerMetrics.safeRecordHeartbeat('success', 0.25)
    playerMetrics.setPlayerState('PAIRED_RUNTIME')
    playerMetrics.recordCommandOutcome('REFRESH', 'heartbeat', 'success')
    playerMetrics.recordScreenshotUpload('queued')
    playerMetrics.setLastScheduleSync('2026-04-08T10:00:00.000Z')

    healthServer = new HealthServer()
    healthServer.start()

    const response = await httpGet('http://127.0.0.1:33301/metrics')

    expect(response.statusCode).to.equal(200)
    expect(response.headers['content-type']).to.contain('text/plain')
    expect(response.body).to.contain('signhex_player_info')
    expect(response.body).to.contain('signhex_player_heartbeat_total{result="success"} 1')
    expect(response.body).to.contain('signhex_player_request_queue_items{category="all"} 2')
    expect(response.body).to.contain('signhex_player_cache_bytes{state="used"} 400')
    expect(response.body).to.contain('signhex_player_state{state="PAIRED_RUNTIME"} 1')
    expect(response.body).to.contain('signhex_player_command_total{command_type="REFRESH",source="heartbeat",result="success"} 1')
    expect(response.body).to.contain('signhex_player_screenshot_upload_total{result="queued"} 1')
  })

  it('keeps health checks available while metrics exposure is disabled by config', async () => {
    writeConfig({
      observability: {
        enabled: true,
        metricsEnabled: false,
        bindAddress: '127.0.0.1',
        port: 33302,
        allowRemoteAccess: false,
      },
    })
    resetModules()

    const { HealthServer } = require('../../../src/main/services/telemetry/health-server')
    const { getSystemStatsCollector } = require('../../../src/main/services/telemetry/system-stats')
    const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')

    sandbox.stub(getSystemStatsCollector(), 'collect').resolves({
      cpuUsage: 10,
      cpuCores: 4,
      cpuLoad1m: 0.1,
      cpuLoad5m: 0.1,
      cpuLoad15m: 0.1,
      memoryUsage: 1024,
      memoryTotal: 4096,
      memoryFree: 3072,
      diskUsage: 1024,
      diskTotal: 8192,
      diskFree: 7168,
      uptime: 100,
      networkInterfaces: [],
      displayCount: 1,
      displays: [],
      hostname: 'player-host',
      osVersion: 'linux',
    })
    sandbox.stub(getCacheManager(), 'getStats').resolves({
      totalBytes: 1000,
      usedBytes: 100,
      freeBytes: 900,
      entryCount: 1,
      quarantinedCount: 0,
      usagePercent: 10,
      itemCount: 1,
    })

    healthServer = new HealthServer()
    healthServer.start()

    const healthResponse = await httpGet('http://127.0.0.1:33302/healthz')
    const metricsResponse = await httpGet('http://127.0.0.1:33302/metrics')

    expect(healthResponse.statusCode).to.equal(200)
    expect(metricsResponse.statusCode).to.equal(404)
  })
})
