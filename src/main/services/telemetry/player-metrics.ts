import { app } from 'electron'
import { getConfigManager } from '../../../common/config'
import { getLogger } from '../../../common/logger'
import { CommandType, PlayerState, type CacheStats, type SystemStats } from '../../../common/types'
import { getCacheManager } from '../cache/cache-manager'
import { getDeviceStateStore } from '../device-state-store'
import { getRequestQueue } from '../network/request-queue'
import { getProofOfPlayService } from '../pop-service'

const logger = getLogger('player-metrics')

const PLAYER_STATES: PlayerState[] = [
  'BOOT',
  'BOOTSTRAP_AUTH',
  'SOFT_RECOVERY',
  'RECOVERY_REQUIRED',
  'HARD_RECOVERY',
  'PAIRING_PENDING',
  'PAIRING_CONFIRMED',
  'PAIRING_COMPLETING',
  'PAIRED_RUNTIME',
]

function getSafeAppVersion(): string {
  try {
    return typeof app?.getVersion === 'function' ? app.getVersion() : 'unknown'
  } catch {
    return 'unknown'
  }
}

type LabelValues = Record<string, string>
type SampleMap = Map<string, number>

export type HeartbeatResult =
  | 'success'
  | 'queued'
  | 'auth_failure'
  | 'skipped_unpaired'
  | 'skipped_in_flight'
  | 'missing_device_id'
  | 'failed'

export type CommandOutcome = 'success' | 'error' | 'deduplicated' | 'rate_limited'
export type CommandSource = 'heartbeat' | 'poll'
export type CommandAckResult = 'success' | 'queued' | 'auth_failure' | 'skipped_unpaired'
export type ScreenshotUploadResult = 'success' | 'queued' | 'auth_failure' | 'failed'
export type CertificateValidationResult = 'x509_valid' | 'compatibility_accepted' | 'strict_rejected'

type CounterMetric = {
  help: string
  type: 'counter'
  labelNames: readonly string[]
  samples: SampleMap
}

type GaugeMetric = {
  help: string
  type: 'gauge'
  labelNames: readonly string[]
  samples: SampleMap
}

type HistogramState = {
  buckets: Map<number, number>
  count: number
  sum: number
}

type HistogramMetric = {
  help: string
  type: 'histogram'
  labelNames: readonly string[]
  buckets: readonly number[]
  samples: Map<string, HistogramState>
}

class SimplePrometheusRegistry {
  private readonly counters = new Map<string, CounterMetric>()
  private readonly gauges = new Map<string, GaugeMetric>()
  private readonly histograms = new Map<string, HistogramMetric>()

  createCounter(name: string, help: string, labelNames: readonly string[] = []): void {
    this.counters.set(name, {
      help,
      type: 'counter',
      labelNames,
      samples: new Map(),
    })
  }

  createGauge(name: string, help: string, labelNames: readonly string[] = []): void {
    this.gauges.set(name, {
      help,
      type: 'gauge',
      labelNames,
      samples: new Map(),
    })
  }

  createHistogram(name: string, help: string, buckets: readonly number[], labelNames: readonly string[] = []): void {
    this.histograms.set(name, {
      help,
      type: 'histogram',
      labelNames,
      buckets,
      samples: new Map(),
    })
  }

  incCounter(name: string, labels: LabelValues = {}, value = 1): void {
    const metric = this.counters.get(name)
    if (!metric) {
      throw new Error(`Unknown counter metric: ${name}`)
    }

    const key = this.labelKey(metric.labelNames, labels)
    metric.samples.set(key, (metric.samples.get(key) || 0) + value)
  }

  setGauge(name: string, labels: LabelValues = {}, value: number): void {
    const metric = this.gauges.get(name)
    if (!metric) {
      throw new Error(`Unknown gauge metric: ${name}`)
    }

    const key = this.labelKey(metric.labelNames, labels)
    metric.samples.set(key, value)
  }

  observeHistogram(name: string, labels: LabelValues = {}, value: number): void {
    const metric = this.histograms.get(name)
    if (!metric) {
      throw new Error(`Unknown histogram metric: ${name}`)
    }

    const key = this.labelKey(metric.labelNames, labels)
    const existing = metric.samples.get(key) || {
      buckets: new Map(metric.buckets.map((bucket) => [bucket, 0])),
      count: 0,
      sum: 0,
    }

    for (const bucket of metric.buckets) {
      if (value <= bucket) {
        existing.buckets.set(bucket, (existing.buckets.get(bucket) || 0) + 1)
      }
    }

    existing.count += 1
    existing.sum += value
    metric.samples.set(key, existing)
  }

  render(): string {
    const lines: string[] = []

    for (const [name, metric] of this.counters) {
      lines.push(`# HELP ${name} ${metric.help}`)
      lines.push(`# TYPE ${name} counter`)
      lines.push(...this.renderSamples(name, metric.labelNames, metric.samples))
      lines.push('')
    }

    for (const [name, metric] of this.gauges) {
      lines.push(`# HELP ${name} ${metric.help}`)
      lines.push(`# TYPE ${name} gauge`)
      lines.push(...this.renderSamples(name, metric.labelNames, metric.samples))
      lines.push('')
    }

    for (const [name, metric] of this.histograms) {
      lines.push(`# HELP ${name} ${metric.help}`)
      lines.push(`# TYPE ${name} histogram`)

      for (const [key, state] of metric.samples) {
        const labels = this.parseLabelKey(metric.labelNames, key)
        for (const bucket of metric.buckets) {
          lines.push(
            `${name}_bucket${this.renderLabels(metric.labelNames.concat('le'), {
              ...labels,
              le: String(bucket),
            })} ${state.buckets.get(bucket) || 0}`
          )
        }

        lines.push(
          `${name}_bucket${this.renderLabels(metric.labelNames.concat('le'), {
            ...labels,
            le: '+Inf',
          })} ${state.count}`
        )
        lines.push(`${name}_sum${this.renderLabels(metric.labelNames, labels)} ${this.formatNumber(state.sum)}`)
        lines.push(`${name}_count${this.renderLabels(metric.labelNames, labels)} ${state.count}`)
      }

      lines.push('')
    }

    return `${lines.join('\n').trim()}\n`
  }

  private renderSamples(name: string, labelNames: readonly string[], samples: SampleMap): string[] {
    const lines: string[] = []
    for (const [key, value] of samples) {
      lines.push(
        `${name}${this.renderLabels(labelNames, this.parseLabelKey(labelNames, key))} ${this.formatNumber(value)}`
      )
    }
    return lines
  }

  private labelKey(labelNames: readonly string[], labels: LabelValues): string {
    return labelNames.map((labelName) => `${labelName}=${labels[labelName] || ''}`).join('\u0000')
  }

  private parseLabelKey(labelNames: readonly string[], key: string): LabelValues {
    const values = key === '' ? [] : key.split('\u0000')
    return labelNames.reduce<LabelValues>((result, labelName, index) => {
      const current = values[index]
      result[labelName] = current ? current.slice(labelName.length + 1) : ''
      return result
    }, {})
  }

  private renderLabels(labelNames: readonly string[], labels: LabelValues): string {
    if (labelNames.length === 0) {
      return ''
    }

    const rendered = labelNames
      .map((labelName) => `${labelName}="${this.escapeLabelValue(labels[labelName] || '')}"`)
      .join(',')
    return `{${rendered}}`
  }

  private escapeLabelValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
  }

  private formatNumber(value: number): string {
    if (Number.isInteger(value)) {
      return String(value)
    }

    return Number(value.toFixed(6)).toString()
  }
}

export class PlayerMetrics {
  private readonly registry = new SimplePrometheusRegistry()
  private readonly requestQueueAdjustmentSnapshots = new Map<string, number>()
  private readonly popReplayAdjustmentSnapshots = new Map<string, number>()

  constructor() {
    this.registry.createGauge('signhex_player_info', 'Static player runtime metadata', ['app_version', 'runtime_mode'])
    this.registry.createCounter('signhex_player_heartbeat_total', 'Player heartbeat outcomes', ['result'])
    this.registry.createHistogram(
      'signhex_player_heartbeat_duration_seconds',
      'Player heartbeat duration in seconds',
      [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      ['result']
    )
    this.registry.createCounter(
      'signhex_player_heartbeat_skips_total',
      'Skipped player heartbeat runs by reason',
      ['reason']
    )
    this.registry.createGauge(
      'signhex_player_last_successful_heartbeat_unixtime',
      'Unix timestamp of the last successful player heartbeat'
    )
    this.registry.createGauge('signhex_player_request_queue_items', 'Queued request count by category', ['category'])
    this.registry.createGauge('signhex_player_request_queue_bytes', 'Queued request bytes by category', ['category'])
    this.registry.createGauge('signhex_player_request_queue_budget_items', 'Request queue item budget by category', ['category'])
    this.registry.createGauge('signhex_player_request_queue_budget_bytes', 'Request queue byte budget by category', ['category'])
    this.registry.createGauge(
      'signhex_player_request_queue_oldest_age_seconds',
      'Age of the oldest queued request in seconds by category',
      ['category']
    )
    this.registry.createCounter(
      'signhex_player_request_queue_adjustments_total',
      'Cumulative request queue drops and compactions by category.',
      ['category', 'action']
    )
    this.registry.createGauge(
      'signhex_player_pop_replay_backlog',
      'Proof-of-play replay backlog by state.',
      ['state']
    )
    this.registry.createGauge(
      'signhex_player_pop_replay_budget',
      'Proof-of-play replay budget by state.',
      ['state']
    )
    this.registry.createCounter(
      'signhex_player_pop_replay_adjustments_total',
      'Cumulative proof-of-play replay drops and compactions.',
      ['action']
    )
    this.registry.createGauge('signhex_player_cache_bytes', 'Player cache capacity and usage in bytes', ['state'])
    this.registry.createGauge('signhex_player_cache_entries', 'Player cache entry counts', ['state'])
    this.registry.createGauge('signhex_player_state', 'One-hot player lifecycle state gauge', ['state'])
    this.registry.createCounter('signhex_player_command_total', 'Player command processing outcomes', [
      'command_type',
      'source',
      'result',
    ])
    this.registry.createCounter('signhex_player_command_ack_total', 'Player command acknowledgment outcomes', [
      'result',
    ])
    this.registry.createCounter('signhex_player_screenshot_upload_total', 'Player screenshot upload outcomes', [
      'result',
    ])
    this.registry.createCounter(
      'signhex_player_certificate_validation_total',
      'Player certificate validation and compatibility outcomes',
      ['result']
    )
    this.registry.createGauge('signhex_player_last_schedule_sync_unixtime', 'Unix timestamp of the last schedule sync')
    this.registry.createCounter(
      'signhex_player_metrics_scrape_failures_total',
      'Player metrics collector failures during scrape',
      ['collector']
    )
    this.registry.createGauge('signhex_player_system_cpu_usage_percent', 'Player host CPU usage percent')
    this.registry.createGauge('signhex_player_system_cpu_cores', 'Player host CPU core count')
    this.registry.createGauge('signhex_player_system_memory_bytes', 'Player host memory bytes', ['state'])
    this.registry.createGauge('signhex_player_system_disk_bytes', 'Player host disk bytes', ['state'])
    this.registry.createGauge(
      'signhex_player_system_temperature_celsius',
      'Player host reported temperature in Celsius'
    )
    this.registry.createGauge('signhex_player_system_uptime_seconds', 'Player host uptime in seconds')
    this.registry.createGauge('signhex_player_display_count', 'Attached display count')
    this.registry.createGauge('signhex_player_battery_percent', 'Player battery percentage when available')
    this.registry.createGauge('signhex_player_power_connected', 'Whether the player reports charging or AC power')

    this.updatePlayerInfoGauge()
    this.setPlayerState('BOOT')
  }

  safeRecordHeartbeat(result: HeartbeatResult, durationSeconds: number): void {
    this.captureMetricError('heartbeat', () => {
      this.registry.incCounter('signhex_player_heartbeat_total', { result })
      this.registry.observeHistogram(
        'signhex_player_heartbeat_duration_seconds',
        { result },
        Math.max(durationSeconds, 0)
      )
      if (result === 'skipped_in_flight') {
        this.registry.incCounter('signhex_player_heartbeat_skips_total', { reason: 'in_flight' })
      }
      if (result === 'success') {
        this.registry.setGauge('signhex_player_last_successful_heartbeat_unixtime', {}, Math.floor(Date.now() / 1000))
      }
    })
  }

  setLastSuccessfulHeartbeat(timestamp: Date | number | string): void {
    this.captureMetricError('heartbeat', () => {
      const unixTime = this.toUnixSeconds(timestamp)
      if (unixTime > 0) {
        this.registry.setGauge('signhex_player_last_successful_heartbeat_unixtime', {}, unixTime)
      }
    })
  }

  setPlayerState(state: PlayerState): void {
    this.captureMetricError('player_state', () => {
      for (const candidate of PLAYER_STATES) {
        this.registry.setGauge('signhex_player_state', { state: candidate }, candidate === state ? 1 : 0)
      }
    })
  }

  recordCommandOutcome(commandType: CommandType, source: CommandSource, result: CommandOutcome): void {
    this.captureMetricError('command', () => {
      this.registry.incCounter('signhex_player_command_total', {
        command_type: this.normalizeCommandType(commandType),
        source,
        result,
      })
    })
  }

  recordCommandAck(result: CommandAckResult): void {
    this.captureMetricError('command_ack', () => {
      this.registry.incCounter('signhex_player_command_ack_total', { result })
    })
  }

  recordScreenshotUpload(result: ScreenshotUploadResult): void {
    this.captureMetricError('screenshot', () => {
      this.registry.incCounter('signhex_player_screenshot_upload_total', { result })
    })
  }

  recordCertificateValidation(result: CertificateValidationResult): void {
    this.captureMetricError('certificate_validation', () => {
      this.registry.incCounter('signhex_player_certificate_validation_total', { result })
    })
  }

  setLastScheduleSync(timestamp: Date | number | string = Date.now()): void {
    this.captureMetricError('schedule_sync', () => {
      const unixTime = this.toUnixSeconds(timestamp)
      if (unixTime > 0) {
        this.registry.setGauge('signhex_player_last_schedule_sync_unixtime', {}, unixTime)
      }
    })
  }

  async renderPrometheusMetrics(collectSystemStats: () => Promise<SystemStats>): Promise<string> {
    this.updatePlayerInfoGauge()

    await this.captureCollector('system_stats', async () => {
      const systemStats = await collectSystemStats()
      this.updateSystemStats(systemStats)
    })

    await this.captureCollector('cache', async () => {
      const cacheStats = await getCacheManager().getStats()
      this.updateCacheStats(cacheStats)
    })

    await this.captureCollector('request_queue', () => {
      this.updateQueueStats()
    })

    await this.captureCollector('pop_replay', () => {
      this.updateProofOfPlayReplayStats()
    })

    await this.captureCollector('device_state', () => {
      const lastHeartbeatAt = getDeviceStateStore().getState().lastHeartbeatAt
      if (lastHeartbeatAt) {
        this.setLastSuccessfulHeartbeat(lastHeartbeatAt)
      }
    })

    return this.registry.render()
  }

  private async captureCollector(collector: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (error) {
      this.registry.incCounter('signhex_player_metrics_scrape_failures_total', { collector })
      logger.warn({ collector, error }, 'Metrics collector failed during scrape')
    }
  }

  private updatePlayerInfoGauge(): void {
    const config = getConfigManager().getConfig()
    this.registry.setGauge(
      'signhex_player_info',
      {
        app_version: getSafeAppVersion(),
        runtime_mode: config.runtime.mode,
      },
      1
    )
  }

  private updateSystemStats(systemStats: SystemStats): void {
    this.registry.setGauge('signhex_player_system_cpu_usage_percent', {}, systemStats.cpuUsage)
    this.registry.setGauge('signhex_player_system_cpu_cores', {}, systemStats.cpuCores)
    this.registry.setGauge('signhex_player_system_memory_bytes', { state: 'used' }, systemStats.memoryUsage)
    this.registry.setGauge('signhex_player_system_memory_bytes', { state: 'free' }, systemStats.memoryFree)
    this.registry.setGauge('signhex_player_system_memory_bytes', { state: 'total' }, systemStats.memoryTotal)
    this.registry.setGauge('signhex_player_system_disk_bytes', { state: 'used' }, systemStats.diskUsage)
    this.registry.setGauge('signhex_player_system_disk_bytes', { state: 'free' }, systemStats.diskFree)
    this.registry.setGauge('signhex_player_system_disk_bytes', { state: 'total' }, systemStats.diskTotal)
    this.registry.setGauge('signhex_player_system_uptime_seconds', {}, systemStats.uptime)
    this.registry.setGauge('signhex_player_display_count', {}, systemStats.displayCount)
    this.registry.setGauge(
      'signhex_player_battery_percent',
      {},
      typeof systemStats.batteryPercent === 'number' ? systemStats.batteryPercent : 0
    )
    this.registry.setGauge(
      'signhex_player_power_connected',
      {},
      systemStats.isCharging === true || systemStats.powerSource === 'AC' ? 1 : 0
    )
    if (typeof systemStats.temperature === 'number') {
      this.registry.setGauge('signhex_player_system_temperature_celsius', {}, systemStats.temperature)
    }
  }

  private updateCacheStats(cacheStats: CacheStats & { usagePercent: number; itemCount: number }): void {
    this.registry.setGauge('signhex_player_cache_bytes', { state: 'total' }, cacheStats.totalBytes)
    this.registry.setGauge('signhex_player_cache_bytes', { state: 'used' }, cacheStats.usedBytes)
    this.registry.setGauge('signhex_player_cache_bytes', { state: 'free' }, cacheStats.freeBytes)
    this.registry.setGauge('signhex_player_cache_entries', { state: 'all' }, cacheStats.entryCount)
    this.registry.setGauge('signhex_player_cache_entries', { state: 'quarantined' }, cacheStats.quarantinedCount)
  }

  private updateQueueStats(): void {
    const requestQueue = getRequestQueue()
    const stats = requestQueue.getStats()
    const oldestAgeByCategory = requestQueue.getOldestAgeSeconds()
    const budgets = requestQueue.getBudgetSnapshot()

    this.registry.setGauge('signhex_player_request_queue_items', { category: 'all' }, stats.pendingItems)
    this.registry.setGauge('signhex_player_request_queue_bytes', { category: 'all' }, stats.pendingBytes)
    this.registry.setGauge('signhex_player_request_queue_budget_items', { category: 'all' }, budgets.totalMaxItems)
    this.registry.setGauge('signhex_player_request_queue_budget_bytes', { category: 'all' }, budgets.totalMaxBytes)

    for (const category of Object.keys(stats.categories)) {
      const categoryKey = category as keyof typeof stats.categories
      this.registry.setGauge(
        'signhex_player_request_queue_items',
        { category },
        stats.categories[categoryKey].pendingItems
      )
      this.registry.setGauge(
        'signhex_player_request_queue_bytes',
        { category },
        stats.categories[categoryKey].pendingBytes
      )
      this.registry.setGauge(
        'signhex_player_request_queue_budget_items',
        { category },
        budgets.categories[categoryKey].maxItems
      )
      this.registry.setGauge(
        'signhex_player_request_queue_budget_bytes',
        { category },
        budgets.categories[categoryKey].maxBytes
      )
      this.syncAbsoluteCounter(
        this.requestQueueAdjustmentSnapshots,
        'signhex_player_request_queue_adjustments_total',
        { category, action: 'dropped' },
        stats.categories[categoryKey].dropped
      )
      this.syncAbsoluteCounter(
        this.requestQueueAdjustmentSnapshots,
        'signhex_player_request_queue_adjustments_total',
        { category, action: 'compacted' },
        stats.categories[categoryKey].compacted
      )
    }

    for (const [category, oldestAge] of Object.entries(oldestAgeByCategory)) {
      this.registry.setGauge('signhex_player_request_queue_oldest_age_seconds', { category }, oldestAge)
    }
  }

  private updateProofOfPlayReplayStats(): void {
    const proofOfPlayService = getProofOfPlayService()
    const stats = proofOfPlayService.getReplayStats()
    const budgets = proofOfPlayService.getReplayBudget()

    this.registry.setGauge('signhex_player_pop_replay_backlog', { state: 'buffer_items' }, stats.bufferItems)
    this.registry.setGauge('signhex_player_pop_replay_backlog', { state: 'buffer_bytes' }, stats.bufferBytes)
    this.registry.setGauge('signhex_player_pop_replay_backlog', { state: 'spool_files' }, stats.spoolFiles)
    this.registry.setGauge('signhex_player_pop_replay_backlog', { state: 'spool_bytes' }, stats.spoolBytes)

    this.registry.setGauge('signhex_player_pop_replay_budget', { state: 'buffer_items' }, budgets.maxBufferEvents)
    this.registry.setGauge('signhex_player_pop_replay_budget', { state: 'buffer_bytes' }, budgets.maxBufferBytes)
    this.registry.setGauge('signhex_player_pop_replay_budget', { state: 'spool_files' }, budgets.maxSpoolFiles)
    this.registry.setGauge('signhex_player_pop_replay_budget', { state: 'spool_bytes' }, budgets.maxSpoolBytes)
    this.registry.setGauge(
      'signhex_player_pop_replay_budget',
      { state: 'max_events_per_file' },
      budgets.maxSpoolEventsPerFile
    )
    this.registry.setGauge(
      'signhex_player_pop_replay_budget',
      { state: 'replay_batch_size' },
      budgets.maxReplayBatchSize
    )

    this.syncAbsoluteCounter(
      this.popReplayAdjustmentSnapshots,
      'signhex_player_pop_replay_adjustments_total',
      { action: 'dropped' },
      stats.droppedEvents
    )
    this.syncAbsoluteCounter(
      this.popReplayAdjustmentSnapshots,
      'signhex_player_pop_replay_adjustments_total',
      { action: 'compacted' },
      stats.compactedEvents
    )
  }

  private syncAbsoluteCounter(
    snapshotStore: Map<string, number>,
    metricName: string,
    labels: LabelValues,
    currentValue: number
  ): void {
    const key = JSON.stringify(labels)
    const previousValue = snapshotStore.get(key) ?? 0
    if (currentValue < previousValue) {
      snapshotStore.set(key, currentValue)
      return
    }

    const delta = currentValue - previousValue
    if (delta > 0) {
      this.registry.incCounter(metricName, labels, delta)
    }

    snapshotStore.set(key, currentValue)
  }

  private captureMetricError(context: string, fn: () => void): void {
    try {
      fn()
    } catch (error) {
      logger.warn({ context, error }, 'Player metric update failed')
    }
  }

  private normalizeCommandType(commandType: CommandType): string {
    return commandType === 'TAKE_SCREENSHOT' ? 'SCREENSHOT' : commandType
  }

  private toUnixSeconds(timestamp: Date | number | string): number {
    if (timestamp instanceof Date) {
      return Math.floor(timestamp.getTime() / 1000)
    }

    if (typeof timestamp === 'number') {
      return Math.floor(timestamp / 1000)
    }

    const parsed = Date.parse(timestamp)
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000)
  }
}

let playerMetrics: PlayerMetrics | null = null

export function getPlayerMetrics(): PlayerMetrics {
  if (!playerMetrics) {
    playerMetrics = new PlayerMetrics()
  }

  return playerMetrics
}

export function resetPlayerMetrics(): void {
  playerMetrics = null
}
