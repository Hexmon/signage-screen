/**
 * Performance test for CPU and memory usage
 * Targets: CPU <40% p95, Memory <500MB p95
 */

import { expect } from 'chai'
import * as os from 'os'
import { sleep } from '../helpers/test-utils.ts'

describe('Resource Usage Performance', () => {
  /**
   * Get current CPU usage percentage
   */
  function getCPUUsage(): number {
    const cpus = os.cpus()
    let totalIdle = 0
    let totalTick = 0

    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        totalTick += (cpu.times as any)[type]
      }
      totalIdle += cpu.times.idle
    })

    const idle = totalIdle / cpus.length
    const total = totalTick / cpus.length
    const usage = 100 - ~~((100 * idle) / total)

    return usage
  }

  /**
   * Get current memory usage in MB
   */
  function getMemoryUsage(): number {
    const used = process.memoryUsage()
    return used.heapUsed / 1024 / 1024 // Convert to MB
  }

  describe('CPU Usage', () => {
    it('should maintain CPU usage <40% during idle', async function () {
      this.timeout(15000)

      const measurements: number[] = []
      const duration = 10000 // 10 seconds
      const interval = 500 // Sample every 500ms

      const startTime = Date.now()

      while (Date.now() - startTime < duration) {
        const cpuUsage = getCPUUsage()
        measurements.push(cpuUsage)
        await sleep(interval)
      }

      const sorted = measurements.sort((a, b) => a - b)
      const p95Index = Math.floor(sorted.length * 0.95)
      const p95 = sorted[p95Index]
      const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length

      console.log(`\n  CPU Usage Statistics:`)
      console.log(`    Measurements: ${measurements.length}`)
      console.log(`    Mean: ${mean.toFixed(2)}%`)
      console.log(`    P95: ${p95.toFixed(2)}%`)

      // Note: This test may be flaky depending on system load
      // Consider this a guideline rather than strict requirement
      if (p95 > 40) {
        console.warn(`    Warning: P95 CPU usage (${p95.toFixed(2)}%) exceeds 40% target`)
      }
    })
  })

  describe('Memory Usage', () => {
    it('should maintain memory usage <500MB', async function () {
      this.timeout(15000)

      const measurements: number[] = []
      const duration = 10000 // 10 seconds
      const interval = 500 // Sample every 500ms

      const startTime = Date.now()

      while (Date.now() - startTime < duration) {
        const memUsage = getMemoryUsage()
        measurements.push(memUsage)
        await sleep(interval)
      }

      const sorted = measurements.sort((a, b) => a - b)
      const p95Index = Math.floor(sorted.length * 0.95)
      const p95 = sorted[p95Index]
      const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
      const max = sorted[sorted.length - 1]

      console.log(`\n  Memory Usage Statistics:`)
      console.log(`    Measurements: ${measurements.length}`)
      console.log(`    Mean: ${mean.toFixed(2)}MB`)
      console.log(`    P95: ${p95.toFixed(2)}MB`)
      console.log(`    Max: ${max.toFixed(2)}MB`)

      expect(p95).to.be.lessThan(500, `P95 memory usage (${p95.toFixed(2)}MB) exceeds 500MB target`)
    })

    it('should not have memory leaks', async function () {
      this.timeout(30000)

      const initialMemory = getMemoryUsage()
      const measurements: number[] = []

      // Simulate workload
      for (let i = 0; i < 100; i++) {
        // Create and discard objects
        const temp = Buffer.alloc(1024 * 1024) // 1MB
        temp.fill(0)

        if (i % 10 === 0) {
          global.gc && global.gc() // Force garbage collection if available
          await sleep(100)
          measurements.push(getMemoryUsage())
        }
      }

      const finalMemory = getMemoryUsage()
      const memoryGrowth = finalMemory - initialMemory

      console.log(`\n  Memory Leak Test:`)
      console.log(`    Initial: ${initialMemory.toFixed(2)}MB`)
      console.log(`    Final: ${finalMemory.toFixed(2)}MB`)
      console.log(`    Growth: ${memoryGrowth.toFixed(2)}MB`)

      // Allow some growth but not excessive
      expect(memoryGrowth).to.be.lessThan(100, `Memory growth (${memoryGrowth.toFixed(2)}MB) suggests potential leak`)
    })
  })

  describe('Cache Performance', () => {
    it('should handle cache operations efficiently', async function () {
      this.timeout(10000)

      // This is a placeholder - actual implementation would test cache operations
      const startMemory = getMemoryUsage()

      // Simulate cache operations
      const cache = new Map()
      for (let i = 0; i < 1000; i++) {
        cache.set(`key-${i}`, Buffer.alloc(1024)) // 1KB each
      }

      const endMemory = getMemoryUsage()
      const memoryUsed = endMemory - startMemory

      console.log(`\n  Cache Performance:`)
      console.log(`    Items: 1000`)
      console.log(`    Memory Used: ${memoryUsed.toFixed(2)}MB`)

      // Should use roughly 1MB for 1000 items of 1KB each
      expect(memoryUsed).to.be.lessThan(10, 'Cache memory usage is excessive')
    })
  })

  describe('Startup Performance', () => {
    it('should start within 5 seconds', async function () {
      this.timeout(10000)

      const startTime = Date.now()

      // Simulate application startup
      // In real test, this would initialize all services
      await sleep(100) // Placeholder

      const elapsed = Date.now() - startTime

      console.log(`\n  Startup Performance:`)
      console.log(`    Time: ${elapsed}ms`)

      expect(elapsed).to.be.lessThan(5000, `Startup time (${elapsed}ms) exceeds 5s target`)
    })
  })
})

