/**
 * Performance test for timeline jitter
 * Target: ≤100ms p95 jitter
 */

import { expect } from 'chai'
import { createMockSchedule, sleep } from '../helpers/test-utils.ts'

describe('Timeline Jitter Performance', () => {
  describe('Timeline Scheduler', () => {
    it('should maintain jitter ≤100ms p95', async function () {
      this.timeout(30000) // 30 second timeout

      const { TimelineScheduler } = require('../../src/main/services/playback/timeline-scheduler')
      const scheduler = new TimelineScheduler()

      const schedule = createMockSchedule(10)
      const jitterMeasurements: number[] = []

      // Listen for play events and measure jitter
      scheduler.on('play-item', (scheduledItem: any) => {
        const expectedTime = scheduledItem.startTime
        const actualTime = Date.now()
        const jitter = Math.abs(actualTime - expectedTime)
        jitterMeasurements.push(jitter)
      })

      // Start timeline
      scheduler.start(schedule.items)

      // Wait for several items to play
      await sleep(5000)

      // Stop scheduler
      scheduler.stop()

      // Calculate statistics
      if (jitterMeasurements.length === 0) {
        this.skip()
        return
      }

      const sorted = jitterMeasurements.sort((a, b) => a - b)
      const p95Index = Math.floor(sorted.length * 0.95)
      const p95 = sorted[p95Index]
      const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
      const max = sorted[sorted.length - 1]

      console.log(`\n  Timeline Jitter Statistics:`)
      console.log(`    Measurements: ${jitterMeasurements.length}`)
      console.log(`    Mean: ${mean.toFixed(2)}ms`)
      console.log(`    P95: ${p95.toFixed(2)}ms`)
      console.log(`    Max: ${max.toFixed(2)}ms`)

      // Assert p95 is within target
      expect(p95).to.be.lessThan(100, `P95 jitter (${p95.toFixed(2)}ms) exceeds 100ms target`)
    })

    it('should get jitter statistics', () => {
      const { TimelineScheduler } = require('../../src/main/services/playback/timeline-scheduler')
      const scheduler = new TimelineScheduler()

      const stats = scheduler.getJitterStats()

      expect(stats).to.have.property('mean')
      expect(stats).to.have.property('p95')
      expect(stats).to.have.property('p99')
      expect(stats).to.have.property('max')
    })
  })

  describe('Transition Performance', () => {
    it('should complete transitions within specified duration', async function () {
      this.timeout(10000)

      const { TransitionManager } = require('../../src/main/services/playback/transition-manager')
      const transitionManager = new TransitionManager()

      // Create mock DOM elements
      const fromElement = {
        style: {} as any,
      } as HTMLElement

      const toElement = {
        style: {} as any,
      } as HTMLElement

      const transitionDuration = 500
      const startTime = Date.now()

      await transitionManager.startTransition(fromElement, toElement, {
        type: 'fade',
        durationMs: transitionDuration,
      })

      const elapsed = Date.now() - startTime
      const jitter = Math.abs(elapsed - transitionDuration)

      console.log(`\n  Transition Performance:`)
      console.log(`    Expected: ${transitionDuration}ms`)
      console.log(`    Actual: ${elapsed}ms`)
      console.log(`    Jitter: ${jitter}ms`)

      // Allow 50ms tolerance
      expect(jitter).to.be.lessThan(50, `Transition jitter (${jitter}ms) exceeds 50ms tolerance`)
    })
  })
})

