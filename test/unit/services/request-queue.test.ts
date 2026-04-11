const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const { createTempDir, cleanupTempDir } = require('../../helpers/test-utils.ts')

describe('Request Queue', () => {
  let tempDir: string
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    tempDir = createTempDir('request-queue-test-')

    process.env.HEXMON_CONFIG_PATH = path.join(tempDir, 'config.json')
    fs.writeFileSync(
      process.env.HEXMON_CONFIG_PATH,
      JSON.stringify(
        {
          apiBase: 'https://api-test.hexmon.com',
          wsUrl: 'wss://api-test.hexmon.com/ws',
          deviceId: 'queue-device',
          cache: {
            path: path.join(tempDir, 'cache'),
            maxBytes: 1024 * 1024,
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

  afterEach(async () => {
    sandbox.restore()
    delete process.env.HEXMON_CONFIG_PATH

    try {
      const { getRequestQueue } = require('../../../src/main/services/network/request-queue')
      await getRequestQueue().cleanup()
    } catch {
      // ignore cleanup during module resets
    }

    cleanupTempDir(tempDir)
    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/main/services') || key.includes('src/common')) {
        delete require.cache[key]
      }
    })
  })

  it('compacts oversized heartbeat backlog and exposes queue stats', async () => {
    const { getRequestQueue } = require('../../../src/main/services/network/request-queue')
    const requestQueue = getRequestQueue()

    for (let index = 0; index < 40; index += 1) {
      await requestQueue.enqueue({
        method: 'POST',
        url: '/api/v1/device/heartbeat',
        data: {
          seq: index,
          blob: 'x'.repeat(12000),
        },
        maxRetries: 3,
      })
    }

    const queue = requestQueue.getQueue()
    const stats = requestQueue.getStats()

    expect(queue.filter((entry: any) => entry.category === 'heartbeat').length).to.be.at.most(24)
    expect(stats.pendingItems).to.equal(queue.length)
    expect(stats.pendingBytes).to.be.at.most(256 * 1024)
    expect(stats.compacted).to.be.greaterThan(0)
    expect(stats.lastCompactionReason).to.be.a('string')

    const budgets = requestQueue.getBudgetSnapshot()
    const oldestAges = requestQueue.getOldestAgeSeconds()

    expect(budgets.totalMaxItems).to.equal(256)
    expect(budgets.totalMaxBytes).to.equal(512 * 1024)
    expect(budgets.categories.heartbeat.maxItems).to.equal(24)
    expect(budgets.categories.screenshot.maxBytes).to.equal(512 * 1024)
    expect(oldestAges.all).to.be.greaterThanOrEqual(0)
    expect(oldestAges.heartbeat).to.be.greaterThanOrEqual(0)
  })

  it('replays queued requests in paced endpoint-aware batches', async () => {
    const { getRequestQueue } = require('../../../src/main/services/network/request-queue')
    const { getHttpClient } = require('../../../src/main/services/network/http-client')
    const requestQueue = getRequestQueue()
    const httpClient = getHttpClient()

    const postStub = sandbox.stub(httpClient, 'post').resolves({})

    for (let index = 0; index < 10; index += 1) {
      await requestQueue.enqueue({
        method: 'POST',
        url: '/api/v1/device/heartbeat',
        data: {
          seq: index,
        },
        maxRetries: 3,
      })
    }

    for (let index = 0; index < 3; index += 1) {
      await requestQueue.enqueue({
        method: 'POST',
        url: '/api/v1/device/screenshot',
        data: {
          seq: index,
          image_data: Buffer.from(`img-${index}`).toString('base64'),
        },
        maxRetries: 3,
      })
    }

    await requestQueue.flush()

    expect(postStub.callCount).to.equal(5)
    expect(requestQueue.getSize()).to.equal(8)
  })

  it('returns false when an incoming request cannot fit within queue budgets', async () => {
    const { getRequestQueue } = require('../../../src/main/services/network/request-queue')
    const requestQueue = getRequestQueue()

    const accepted = await requestQueue.enqueue({
      method: 'POST',
      url: '/api/v1/device/screenshot',
      data: {
        image_data: 'x'.repeat(700 * 1024),
      },
      maxRetries: 3,
    })

    expect(accepted).to.equal(false)
    expect(requestQueue.getSize()).to.equal(0)
  })
})
