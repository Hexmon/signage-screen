/**
 * Unit tests for Cache Manager
 */

import { expect } from 'chai'
import * as sinon from 'sinon'
import * as fs from 'fs'
import * as path from 'path'
import { createTempDir, cleanupTempDir, calculateHash } from '../../helpers/test-utils.ts'

describe('Cache Manager', () => {
  let tempDir: string
  let cacheDir: string
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    tempDir = createTempDir('cache-test-')
    cacheDir = path.join(tempDir, 'cache')
    fs.mkdirSync(cacheDir, { recursive: true })

    // Mock config
    process.env.HEXMON_CONFIG_PATH = path.join(tempDir, 'config.json')
    const testConfig = {
      apiBase: 'https://api-test.hexmon.com',
      wsUrl: 'wss://api-test.hexmon.com/ws',
      cache: {
        path: cacheDir,
        maxBytes: 10485760, // 10MB for testing
        prefetchConcurrency: 2,
      },
      intervals: {
        heartbeatMs: 300000,
        commandPollMs: 30000,
        schedulePollMs: 300000,
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

    // Clear module cache
    delete require.cache[require.resolve('../../../src/main/services/cache/cache-manager')]
    delete require.cache[require.resolve('../../../src/common/config')]
  })

  describe('Cache Operations', () => {
    it('should add item to cache', async () => {
      const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
      const cacheManager = getCacheManager()

      const mediaId = 'test-file.jpg'
      const testData = Buffer.from('test content')
      const hash = calculateHash(testData)

      // Mock download
      sandbox.stub(cacheManager, 'download' as any).resolves(testData)

      await cacheManager.add(mediaId, `https://example.com/${mediaId}`, hash)

      const exists = await cacheManager.has(mediaId)
      expect(exists).to.be.true
    })

    it('should retrieve cached item', async () => {
      const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
      const cacheManager = getCacheManager()

      const mediaId = 'test-file.jpg'
      const testData = Buffer.from('test content')
      const hash = calculateHash(testData)

      // Mock download
      sandbox.stub(cacheManager, 'download' as any).resolves(testData)

      await cacheManager.add(mediaId, `https://example.com/${mediaId}`, hash)
      const filePath = await cacheManager.get(mediaId)

      expect(filePath).to.exist
      expect(fs.existsSync(filePath!)).to.be.true
    })

    it('should verify integrity with SHA-256', async () => {
      const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
      const cacheManager = getCacheManager()

      const mediaId = 'test-file.jpg'
      const testData = Buffer.from('test content')
      const correctHash = calculateHash(testData)
      const wrongHash = 'wrong-hash-value'

      // Mock download
      sandbox.stub(cacheManager, 'download' as any).resolves(testData)

      // Should succeed with correct hash
      await cacheManager.add(mediaId, `https://example.com/${mediaId}`, correctHash)
      expect(await cacheManager.has(mediaId)).to.be.true

      // Should fail with wrong hash
      try {
        await cacheManager.add('bad-file.jpg', 'https://example.com/bad-file.jpg', wrongHash)
        expect.fail('Should have thrown integrity error')
      } catch (error: any) {
        expect(error.message).to.include('integrity')
      }
    })

    it('should evict LRU items when cache is full', async () => {
      const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
      const cacheManager = getCacheManager()

      // Create files that exceed cache size
      const file1 = Buffer.alloc(6 * 1024 * 1024) // 6MB
      const file2 = Buffer.alloc(6 * 1024 * 1024) // 6MB

      sandbox.stub(cacheManager, 'download' as any)
        .onFirstCall().resolves(file1)
        .onSecondCall().resolves(file2)

      await cacheManager.add('file1.jpg', 'https://example.com/file1.jpg', calculateHash(file1))
      await cacheManager.add('file2.jpg', 'https://example.com/file2.jpg', calculateHash(file2))

      // file1 should be evicted
      const has1 = await cacheManager.has('file1.jpg')
      const has2 = await cacheManager.has('file2.jpg')

      expect(has1).to.be.false
      expect(has2).to.be.true
    })

    it('should protect now-playing content from eviction', async () => {
      const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
      const cacheManager = getCacheManager()

      const file1 = Buffer.alloc(6 * 1024 * 1024)
      const file2 = Buffer.alloc(6 * 1024 * 1024)

      sandbox.stub(cacheManager, 'download' as any)
        .onFirstCall().resolves(file1)
        .onSecondCall().resolves(file2)

      await cacheManager.add('file1.jpg', 'https://example.com/file1.jpg', calculateHash(file1))
      cacheManager.markNowPlaying('file1.jpg')

      await cacheManager.add('file2.jpg', 'https://example.com/file2.jpg', calculateHash(file2))

      // file1 should NOT be evicted because it's now-playing
      const has1 = await cacheManager.has('file1.jpg')
      expect(has1).to.be.true
    })
  })

  describe('Cache Statistics', () => {
    it('should track cache usage', async () => {
      const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
      const cacheManager = getCacheManager()

      const testData = Buffer.alloc(1024 * 1024) // 1MB
      sandbox.stub(cacheManager, 'download' as any).resolves(testData)

      await cacheManager.add('file.jpg', 'https://example.com/file.jpg', calculateHash(testData))

      const stats = await cacheManager.getStats()
      expect(stats.usedBytes).to.be.greaterThan(0)
      expect(stats.itemCount).to.equal(1)
    })

    it('should calculate cache usage percentage', async () => {
      const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
      const cacheManager = getCacheManager()

      const testData = Buffer.alloc(5 * 1024 * 1024) // 5MB (50% of 10MB)
      sandbox.stub(cacheManager, 'download' as any).resolves(testData)

      await cacheManager.add('file.jpg', 'https://example.com/file.jpg', calculateHash(testData))

      const stats = await cacheManager.getStats()
      expect(stats.usagePercent).to.be.closeTo(50, 5)
    })
  })

  describe('Cache Cleanup', () => {
    it('should clear cache', async () => {
      const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
      const cacheManager = getCacheManager()

      const testData = Buffer.from('test content')
      sandbox.stub(cacheManager, 'download' as any).resolves(testData)

      await cacheManager.add('file.jpg', 'https://example.com/file.jpg', calculateHash(testData))
      await cacheManager.clear()

      const has = await cacheManager.has('file.jpg')
      expect(has).to.be.false
    })

    it('should cleanup on shutdown', async () => {
      const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
      const cacheManager = getCacheManager()

      const cleanupSpy = sandbox.spy(cacheManager, 'cleanup')
      await cacheManager.cleanup()

      expect(cleanupSpy.calledOnce).to.be.true
    })
  })

  describe('Prefetch', () => {
    it('should prefetch multiple items', async () => {
      const { getCacheManager } = require('../../../src/main/services/cache/cache-manager')
      const cacheManager = getCacheManager()

      const items = [
        { mediaId: 'file1.jpg', url: 'https://example.com/file1.jpg', sha256: calculateHash(Buffer.from('1')) },
        { mediaId: 'file2.jpg', url: 'https://example.com/file2.jpg', sha256: calculateHash(Buffer.from('2')) },
      ]

      sandbox.stub(cacheManager, 'download' as any)
        .onFirstCall().resolves(Buffer.from('1'))
        .onSecondCall().resolves(Buffer.from('2'))

      await cacheManager.prefetch(items)

      expect(await cacheManager.has('file1.jpg')).to.be.true
      expect(await cacheManager.has('file2.jpg')).to.be.true
    })
  })
})
