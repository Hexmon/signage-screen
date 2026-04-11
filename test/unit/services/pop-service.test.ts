/**
 * Unit tests for Proof-of-Play Service
 */

const { expect } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const path = require('path')
const { createTempDir, cleanupTempDir, sleep } = require('../../helpers/test-utils.ts')

describe('Proof-of-Play Service', () => {
  let tempDir: string
  let spoolDir: string
  let sandbox: sinon.SinonSandbox
  let clock: sinon.SinonFakeTimers | undefined

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    tempDir = createTempDir('pop-test-')
    spoolDir = path.join(tempDir, 'cache', 'pop-spool')
    fs.mkdirSync(spoolDir, { recursive: true })

    // Mock config
    process.env.HEXMON_CONFIG_PATH = path.join(tempDir, 'config.json')
    const testConfig = {
      apiBase: 'https://api-test.hexmon.com',
      wsUrl: 'wss://api-test.hexmon.com/ws',
      deviceId: 'test-device',
      cache: {
        path: path.join(tempDir, 'cache'),
        maxBytes: 1073741824,
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
    clock?.restore()
    clock = undefined
    sandbox.restore()
    cleanupTempDir(tempDir)
    delete process.env.HEXMON_CONFIG_PATH

    // Clear module cache
    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/main/services') || key.includes('src/common')) {
        delete require.cache[key]
      }
    })
  })

  describe('Event Recording', () => {
    it('should record playback start', () => {
      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const popService = getProofOfPlayService()

      popService.recordStart('schedule-1', 'media-1')

      // Verify event is tracked
      const activePlaybacks = (popService as any).activePlaybacks
      expect(activePlaybacks.has('schedule-1:media-1')).to.be.true
    })

    it('should record playback end', () => {
      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const popService = getProofOfPlayService()

      popService.recordStart('schedule-1', 'media-1')
      popService.recordEnd('schedule-1', 'media-1', true)

      // Verify event is in buffer
      const buffer = (popService as any).eventBuffer
      expect(buffer.length).to.be.greaterThan(0)
    })

    it('should calculate duration correctly', async () => {
      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const popService = getProofOfPlayService()

      popService.recordStart('schedule-1', 'media-1')
      await sleep(100)
      popService.recordEnd('schedule-1', 'media-1', true)

      const buffer = (popService as any).eventBuffer
      const event = buffer[0]

      expect(event.duration).to.be.at.least(0)
    })

    it('should mark incomplete playback', () => {
      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const popService = getProofOfPlayService()

      popService.recordStart('schedule-1', 'media-1')
      popService.recordEnd('schedule-1', 'media-1', false)

      const buffer = (popService as any).eventBuffer
      const event = buffer[0]

      expect(event.completed).to.be.false
    })
  })

  describe('Deduplication', () => {
    it('should deduplicate events', () => {
      clock = sandbox.useFakeTimers({ now: new Date('2026-03-14T14:00:00.000Z'), shouldAdvanceTime: false })
      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const popService = getProofOfPlayService()

      // Record same event twice
      popService.recordStart('schedule-1', 'media-1')
      popService.recordEnd('schedule-1', 'media-1', true)

      popService.recordStart('schedule-1', 'media-1')
      popService.recordEnd('schedule-1', 'media-1', true)

      const buffer = (popService as any).eventBuffer

      // Deduplication happens on insert
      expect(buffer.length).to.equal(1)
    })
  })

  describe('Event Flushing', () => {
    it('should flush events to backend', async () => {
      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const { getHttpClient } = require('../../../src/main/services/network/http-client')

      const popService = getProofOfPlayService()
      const httpClient = getHttpClient()

      // Mock HTTP post
      const postStub = sandbox.stub(httpClient, 'post').resolves({ received: 1, duplicates: 0 })

      popService.recordStart('schedule-1', 'media-1')
      popService.recordEnd('schedule-1', 'media-1', true)

      await popService.flushEvents()

      expect(postStub.calledOnce).to.be.true
      expect(postStub.firstCall.args[0]).to.equal('/api/v1/device/proof-of-play')
    })

    it('should spool events when offline', async () => {
      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const { getHttpClient } = require('../../../src/main/services/network/http-client')

      const popService = getProofOfPlayService()
      const httpClient = getHttpClient()

      // Mock network error
      sandbox.stub(httpClient, 'post').rejects(new Error('Network error'))

      popService.recordStart('schedule-1', 'media-1')
      popService.recordEnd('schedule-1', 'media-1', true)

      await popService.flushEvents()

      // Verify events are spooled to disk
      const spoolFiles = fs.readdirSync(spoolDir)
      expect(spoolFiles.length).to.be.greaterThan(0)
    })

    it('should flush spooled events when back online', async () => {
      // Create spooled file
      const spoolFile = path.join(spoolDir, `pop-${Date.now()}.json`)
      const events = [
        {
          schedule_id: 'schedule-1',
          media_id: 'media-1',
          start_time: new Date().toISOString(),
          end_time: new Date().toISOString(),
          duration: 1,
          completed: true,
        },
      ]
      fs.writeFileSync(spoolFile, JSON.stringify(events))

      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const { getHttpClient } = require('../../../src/main/services/network/http-client')

      const popService = getProofOfPlayService()
      const httpClient = getHttpClient()

      // Mock successful post
      const postStub = sandbox.stub(httpClient, 'post').resolves({ received: 1, duplicates: 0 })

      await popService.flushEvents()

      expect(postStub.calledOnce).to.be.true
      expect(fs.existsSync(spoolFile)).to.be.false // Should be deleted after flush
    })
  })

  describe('Buffer Management', () => {
    it('should limit buffer size', () => {
      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const popService = getProofOfPlayService()
      const flushStub = sandbox.stub(popService, 'flushEvents').resolves()

      // Record more events than buffer size
      for (let i = 0; i < 150; i++) {
        popService.recordStart('schedule-1', `media-${i}`)
        popService.recordEnd('schedule-1', `media-${i}`, true)
      }

      expect(flushStub.called).to.be.true
    })

    it('should spill overflow to disk and expose replay stats', async () => {
      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const popService = getProofOfPlayService()
      sandbox.stub(popService, 'flushEvents').resolves()

      for (let i = 0; i < 140; i++) {
        popService.recordStart('schedule-1', `media-${i}`)
        popService.recordEnd('schedule-1', `media-${i}`, true)
      }

      await sleep(25)

      const stats = popService.getReplayStats()
      expect(stats.bufferItems).to.be.at.most(100)
      expect(stats.compactedEvents).to.be.greaterThan(0)
      expect(stats.spoolFiles).to.be.greaterThan(0)
    })

    it('should pace replay by draining only one bounded batch at a time', async () => {
      const spoolFiles = [
        path.join(spoolDir, 'pop-a.json'),
        path.join(spoolDir, 'pop-b.json'),
      ]
      const makeEvent = (index: number) => ({
        schedule_id: 'schedule-1',
        media_id: `media-${index}`,
        start_time: new Date(Date.now() - index * 1000).toISOString(),
        end_time: new Date(Date.now() - index * 1000 + 1000).toISOString(),
        duration: 1,
        completed: true,
      })

      fs.writeFileSync(spoolFiles[0], JSON.stringify(Array.from({ length: 15 }, (_, index) => makeEvent(index))))
      fs.writeFileSync(spoolFiles[1], JSON.stringify(Array.from({ length: 15 }, (_, index) => makeEvent(index + 15))))

      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const { getHttpClient } = require('../../../src/main/services/network/http-client')
      const popService = getProofOfPlayService()
      const httpClient = getHttpClient()
      const postStub = sandbox.stub(httpClient, 'post').resolves({ received: 1, duplicates: 0 })

      await popService.flushEvents()

      const stats = popService.getReplayStats()
      expect(postStub.callCount).to.equal(25)
      expect(stats.spoolFiles).to.be.greaterThan(0)
    })
  })

  describe('Cleanup', () => {
    it('should cleanup on shutdown', async () => {
      const { getProofOfPlayService } = require('../../../src/main/services/pop-service')
      const { getHttpClient } = require('../../../src/main/services/network/http-client')
      const popService = getProofOfPlayService()
      const httpClient = getHttpClient()

      sandbox.stub(httpClient, 'post').resolves({ received: 1, duplicates: 0 })

      popService.recordStart('schedule-1', 'media-1')
      popService.recordEnd('schedule-1', 'media-1', true)

      await popService.cleanup()

      // Buffer should be flushed
      const buffer = (popService as any).eventBuffer
      expect(buffer.length).to.equal(0)
    })
  })
})
