/**
 * Unit tests for snapshot manager offline fallback
 */

import { expect } from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as sinon from 'sinon'
import { createTempDir, cleanupTempDir } from '../../helpers/test-utils.ts'

describe('Snapshot Manager', () => {
  let tempDir: string
  let cacheDir: string
  let sandbox: sinon.SinonSandbox

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
    sandbox.stub(httpClient, 'get').rejects({ response: { status: 404 } })

    const { getSnapshotManager } = require('../../../src/main/services/snapshot-manager')
    const snapshotManager = getSnapshotManager()

    const playlist = await snapshotManager.refreshSnapshot()

    expect(playlist?.mode).to.equal('offline')
    expect(playlist?.items.length).to.be.greaterThan(0)
  })
})
