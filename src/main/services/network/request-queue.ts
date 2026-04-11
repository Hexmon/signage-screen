/**
 * Request Queue - Offline request queue with bounded persistence and paced replay.
 */

import * as fs from 'fs'
import * as path from 'path'
import { getLogger } from '../../../common/logger'
import { getConfigManager } from '../../../common/config'
import {
  DeviceApiError,
  type RequestQueueBudget,
  type RequestQueueBudgetSnapshot,
  type RequestQueueCategory,
  type RequestQueueOldestAgeSeconds,
  type RequestQueueStats,
} from '../../../common/types'
import { ExponentialBackoff, atomicWrite, ensureDir, sleep } from '../../../common/utils'
import { getHttpClient } from './http-client'
import { getLifecycleEvents } from '../lifecycle-events'
import {
  REQUEST_QUEUE_TOTAL_MAX_ITEMS,
  deriveRequestQueueMaxBytes,
} from '../offline-replay-budgets'

const logger = getLogger('request-queue')

export interface QueuedRequest {
  id: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  data?: any
  headers?: Record<string, string>
  timestamp: number
  retries: number
  maxRetries: number
  sizeBytes: number
  category: RequestQueueCategory
  nextAttemptAt?: number
  lastError?: string
}

const IDLE_FLUSH_MS = 60000
const BACKLOG_FLUSH_MS = 15000

function emptyCategoryStats(): RequestQueueStats['categories'] {
  return {
    heartbeat: { pendingItems: 0, pendingBytes: 0, dropped: 0, compacted: 0 },
    screenshot: { pendingItems: 0, pendingBytes: 0, dropped: 0, compacted: 0 },
    'command-ack': { pendingItems: 0, pendingBytes: 0, dropped: 0, compacted: 0 },
    default: { pendingItems: 0, pendingBytes: 0, dropped: 0, compacted: 0 },
  }
}

export class RequestQueue {
  private queue: QueuedRequest[] = []
  private readonly queuePath: string
  private readonly statePath: string
  private readonly totalMaxBytes: number
  private readonly categoryBudgets: Record<RequestQueueCategory, RequestQueueBudget>
  private flushTimer?: NodeJS.Timeout
  private isFlushing = false
  private stats: RequestQueueStats = {
    pendingItems: 0,
    pendingBytes: 0,
    dropped: 0,
    droppedBytes: 0,
    compacted: 0,
    compactedBytes: 0,
    categories: emptyCategoryStats(),
  }

  constructor() {
    const config = getConfigManager().getConfig()
    this.queuePath = path.join(config.cache.path, 'request-queue.json')
    this.statePath = path.join(config.cache.path, 'request-queue.state.json')
    ensureDir(path.dirname(this.queuePath), 0o755)

    this.totalMaxBytes = deriveRequestQueueMaxBytes(config.cache.maxBytes)
    this.categoryBudgets = this.buildCategoryBudgets(this.totalMaxBytes)

    this.loadState()
    this.loadQueue()
    this.refreshPendingStats()
    this.startPeriodicFlush()

    logger.info(
      {
        queuePath: this.queuePath,
        queueSize: this.queue.length,
        totalMaxBytes: this.totalMaxBytes,
      },
      'Request queue initialized'
    )
  }

  private buildCategoryBudgets(totalMaxBytes: number): Record<RequestQueueCategory, RequestQueueBudget> {
    return {
      heartbeat: {
        maxItems: 24,
        maxBytes: Math.min(256 * 1024, totalMaxBytes),
        replayBatchSize: 4,
        replayDelayMs: [50, 150],
      },
      screenshot: {
        maxItems: 4,
        maxBytes: Math.min(4 * 1024 * 1024, totalMaxBytes),
        replayBatchSize: 1,
        replayDelayMs: [250, 500],
      },
      'command-ack': {
        maxItems: 128,
        maxBytes: Math.min(256 * 1024, totalMaxBytes),
        replayBatchSize: 8,
        replayDelayMs: [50, 150],
      },
      default: {
        maxItems: 64,
        maxBytes: Math.min(512 * 1024, totalMaxBytes),
        replayBatchSize: 6,
        replayDelayMs: [100, 250],
      },
    }
  }

  private loadQueue(): void {
    try {
      if (!fs.existsSync(this.queuePath)) {
        return
      }

      const data = fs.readFileSync(this.queuePath, 'utf-8')
      const parsed = JSON.parse(data)
      const entries = Array.isArray(parsed) ? parsed : []
      this.queue = entries
        .map((entry) => this.normalizeQueuedRequest(entry))
        .filter((entry): entry is QueuedRequest => Boolean(entry))
      logger.info({ count: this.queue.length }, 'Loaded persisted request queue')
    } catch (error) {
      logger.error({ error }, 'Failed to load request queue')
      this.queue = []
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) {
        return
      }

      const data = fs.readFileSync(this.statePath, 'utf-8')
      const parsed = JSON.parse(data) as Partial<RequestQueueStats>
      this.stats = {
        pendingItems: 0,
        pendingBytes: 0,
        dropped: parsed.dropped ?? 0,
        droppedBytes: parsed.droppedBytes ?? 0,
        compacted: parsed.compacted ?? 0,
        compactedBytes: parsed.compactedBytes ?? 0,
        lastDropReason: parsed.lastDropReason,
        lastDropAt: parsed.lastDropAt,
        lastCompactionReason: parsed.lastCompactionReason,
        lastCompactionAt: parsed.lastCompactionAt,
        categories: {
          ...emptyCategoryStats(),
          ...(parsed.categories || {}),
        },
      }
    } catch (error) {
      logger.error({ error }, 'Failed to load request queue state')
    }
  }

  private normalizeQueuedRequest(entry: any): QueuedRequest | null {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string' || typeof entry.method !== 'string') {
      return null
    }

    const method = String(entry.method).toUpperCase() as QueuedRequest['method']
    const category = this.classifyRequest(entry.url)
    const sizeBytes =
      typeof entry.sizeBytes === 'number' && Number.isFinite(entry.sizeBytes)
        ? entry.sizeBytes
        : this.estimateRequestSize({
            method,
            url: entry.url,
            data: entry.data,
            headers: entry.headers,
          })

    return {
      id: typeof entry.id === 'string' ? entry.id : `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      method,
      url: entry.url,
      data: entry.data,
      headers: entry.headers,
      timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
      retries: typeof entry.retries === 'number' ? entry.retries : 0,
      maxRetries: typeof entry.maxRetries === 'number' ? entry.maxRetries : 3,
      sizeBytes,
      category: entry.category || category,
      nextAttemptAt: typeof entry.nextAttemptAt === 'number' ? entry.nextAttemptAt : undefined,
      lastError: typeof entry.lastError === 'string' ? entry.lastError : undefined,
    }
  }

  private estimateRequestSize(request: Pick<QueuedRequest, 'method' | 'url' | 'data' | 'headers'>): number {
    return Buffer.byteLength(
      JSON.stringify({
        method: request.method,
        url: request.url,
        data: request.data ?? null,
        headers: request.headers ?? null,
      }),
      'utf8'
    )
  }

  private classifyRequest(url: string): RequestQueueCategory {
    if (url === '/api/v1/device/heartbeat') {
      return 'heartbeat'
    }
    if (url === '/api/v1/device/screenshot') {
      return 'screenshot'
    }
    if (/\/api\/v1\/device\/.+\/commands\/.+\/ack$/.test(url)) {
      return 'command-ack'
    }
    return 'default'
  }

  private async persist(): Promise<void> {
    try {
      await atomicWrite(this.queuePath, JSON.stringify(this.queue, null, 2))
      await atomicWrite(this.statePath, JSON.stringify(this.stats, null, 2))
    } catch (error) {
      logger.error({ error }, 'Failed to persist request queue state')
    }
  }

  private refreshPendingStats(): void {
    this.stats.pendingItems = this.queue.length
    this.stats.pendingBytes = this.queue.reduce((total, request) => total + request.sizeBytes, 0)

    const categories = emptyCategoryStats()
    for (const request of this.queue) {
      categories[request.category].pendingItems++
      categories[request.category].pendingBytes += request.sizeBytes
      categories[request.category].dropped = this.stats.categories[request.category].dropped
      categories[request.category].compacted = this.stats.categories[request.category].compacted
    }

    for (const category of Object.keys(categories) as RequestQueueCategory[]) {
      categories[category].dropped = this.stats.categories[category].dropped
      categories[category].compacted = this.stats.categories[category].compacted
    }

    this.stats.categories = categories
  }

  private recordQueueRemoval(request: QueuedRequest, action: 'dropped' | 'compacted', reason: string): void {
    const now = new Date().toISOString()
    if (action === 'dropped') {
      this.stats.dropped++
      this.stats.droppedBytes += request.sizeBytes
      this.stats.lastDropReason = reason
      this.stats.lastDropAt = now
      this.stats.categories[request.category].dropped++
    } else {
      this.stats.compacted++
      this.stats.compactedBytes += request.sizeBytes
      this.stats.lastCompactionReason = reason
      this.stats.lastCompactionAt = now
      this.stats.categories[request.category].compacted++
    }

    logger.warn(
      {
        id: request.id,
        category: request.category,
        url: request.url,
        sizeBytes: request.sizeBytes,
        reason,
        action,
      },
      'Removed queued request'
    )
  }

  private removeRequestAt(index: number, action: 'dropped' | 'compacted', reason: string): QueuedRequest | undefined {
    if (index < 0 || index >= this.queue.length) {
      return undefined
    }

    const [removed] = this.queue.splice(index, 1)
    if (removed) {
      this.recordQueueRemoval(removed, action, reason)
      this.refreshPendingStats()
    }
    return removed
  }

  private findOldestIndex(predicate: (request: QueuedRequest) => boolean): number {
    for (let index = 0; index < this.queue.length; index += 1) {
      const request = this.queue[index]
      if (request && predicate(request)) {
        return index
      }
    }
    return -1
  }

  private evictForIncoming(incoming: QueuedRequest): boolean {
    const categoryBudget = this.categoryBudgets[incoming.category]
    if (incoming.sizeBytes > Math.max(categoryBudget.maxBytes, this.totalMaxBytes)) {
      this.recordQueueRemoval(incoming, 'dropped', 'incoming-request-too-large')
      return false
    }

    while (
      this.queue.filter((request) => request.category === incoming.category).length >= categoryBudget.maxItems ||
      this.queue
        .filter((request) => request.category === incoming.category)
        .reduce((total, request) => total + request.sizeBytes, 0) +
        incoming.sizeBytes >
        categoryBudget.maxBytes ||
      this.queue.length >= REQUEST_QUEUE_TOTAL_MAX_ITEMS ||
      this.queue.reduce((total, request) => total + request.sizeBytes, 0) + incoming.sizeBytes > this.totalMaxBytes
    ) {
      let targetIndex = -1
      let action: 'dropped' | 'compacted' = incoming.category === 'heartbeat' ? 'compacted' : 'dropped'
      let reason = 'queue-budget'

      if (
        this.queue.filter((request) => request.category === incoming.category).length >= categoryBudget.maxItems ||
        this.queue
          .filter((request) => request.category === incoming.category)
          .reduce((total, request) => total + request.sizeBytes, 0) +
          incoming.sizeBytes >
          categoryBudget.maxBytes
      ) {
        targetIndex = this.findOldestIndex((request) => request.category === incoming.category)
        reason = `${incoming.category}-budget`
      }

      if (targetIndex === -1) {
        const evictionOrder: RequestQueueCategory[] = ['heartbeat', 'screenshot', 'default', 'command-ack']
        for (const category of evictionOrder) {
          targetIndex = this.findOldestIndex((request) => request.category === category)
          if (targetIndex !== -1) {
            action = category === 'heartbeat' ? 'compacted' : 'dropped'
            reason = `total-budget:${category}`
            break
          }
        }
      }

      if (targetIndex === -1) {
        this.recordQueueRemoval(incoming, 'dropped', 'queue-budget-no-eviction-candidate')
        return false
      }

      this.removeRequestAt(targetIndex, action, reason)
    }

    return true
  }

  private computeRetryDelay(request: QueuedRequest): number {
    const backoff = new ExponentialBackoff(5000, 5 * 60 * 1000, request.maxRetries, 0.25)
    for (let attempt = 0; attempt < request.retries; attempt += 1) {
      backoff.getDelay()
    }
    return backoff.getDelay()
  }

  private jitterRange([minMs, maxMs]: [number, number]): number {
    if (maxMs <= minMs) {
      return minMs
    }
    return minMs + Math.floor(Math.random() * (maxMs - minMs + 1))
  }

  private computeNextFlushDelay(): number {
    if (this.queue.length === 0) {
      return this.jitterRange([IDLE_FLUSH_MS - 5000, IDLE_FLUSH_MS + 5000])
    }

    const nextEligibleAt = this.queue
      .map((request) => request.nextAttemptAt || 0)
      .filter((value) => value > 0)
      .sort((left, right) => left - right)[0]

    const backlogDelay = this.jitterRange([BACKLOG_FLUSH_MS - 3000, BACKLOG_FLUSH_MS + 3000])
    if (!nextEligibleAt) {
      return backlogDelay
    }

    return Math.max(2000, Math.min(backlogDelay, nextEligibleAt - Date.now()))
  }

  private scheduleNextFlush(delayMs?: number): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
    }

    const delay = typeof delayMs === 'number' ? Math.max(1000, delayMs) : this.computeNextFlushDelay()
    this.flushTimer = setTimeout(() => {
      this.flush().catch((error) => {
        logger.error({ error }, 'Periodic flush failed')
      })
    }, delay)
  }

  async enqueue(request: Omit<QueuedRequest, 'id' | 'timestamp' | 'retries' | 'sizeBytes' | 'category'>): Promise<boolean> {
    const queuedRequest: QueuedRequest = {
      ...request,
      id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      timestamp: Date.now(),
      retries: 0,
      sizeBytes: 0,
      category: this.classifyRequest(request.url),
    }
    queuedRequest.sizeBytes = this.estimateRequestSize(queuedRequest)

    if (!this.evictForIncoming(queuedRequest)) {
      await this.persist()
      logger.warn(
        {
          method: queuedRequest.method,
          url: queuedRequest.url,
          category: queuedRequest.category,
          sizeBytes: queuedRequest.sizeBytes,
        },
        'Request queue rejected incoming payload'
      )
      return false
    }

    this.queue.push(queuedRequest)
    this.refreshPendingStats()
    await this.persist()
    this.scheduleNextFlush(2000 + this.jitterRange([0, 1500]))

    logger.info(
      {
        id: queuedRequest.id,
        method: queuedRequest.method,
        url: queuedRequest.url,
        category: queuedRequest.category,
        sizeBytes: queuedRequest.sizeBytes,
      },
      'Request queued'
    )

    return true
  }

  private selectReplayBatch(now: number): QueuedRequest[] {
    const batch: QueuedRequest[] = []
    const selectedByCategory: Record<RequestQueueCategory, number> = {
      heartbeat: 0,
      screenshot: 0,
      'command-ack': 0,
      default: 0,
    }

    for (const request of this.queue) {
      if (batch.length >= 16) {
        break
      }
      if (request.nextAttemptAt && request.nextAttemptAt > now) {
        continue
      }
      const budget = this.categoryBudgets[request.category]
      if (selectedByCategory[request.category] >= budget.replayBatchSize) {
        continue
      }
      batch.push(request)
      selectedByCategory[request.category]++
    }

    return batch
  }

  async flush(): Promise<void> {
    if (this.isFlushing) {
      logger.debug('Already flushing queue')
      return
    }

    if (this.queue.length === 0) {
      this.scheduleNextFlush()
      return
    }

    this.isFlushing = true
    const now = Date.now()
    const batch = this.selectReplayBatch(now)
    if (batch.length === 0) {
      this.isFlushing = false
      this.scheduleNextFlush()
      return
    }

    logger.info({ queued: this.queue.length, replaying: batch.length }, 'Flushing request queue')

    const httpClient = getHttpClient()
    const removeIds = new Set<string>()

    try {
      for (const request of batch) {
        try {
          await this.executeRequest(httpClient, request)
          removeIds.add(request.id)
          logger.debug({ id: request.id, method: request.method, url: request.url }, 'Queued request replayed')
        } catch (error) {
          logger.warn({ id: request.id, error }, 'Queued request replay failed')

          if (
            error instanceof DeviceApiError &&
            (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
          ) {
            getLifecycleEvents().emitRuntimeAuthFailure({
              source: 'request-queue',
              error,
            })
            this.recordQueueRemoval(request, 'dropped', `auth-failure:${error.code}`)
            removeIds.add(request.id)
          } else {
            request.retries += 1
            request.lastError = error instanceof Error ? error.message : String(error)
            if (request.retries >= request.maxRetries) {
              this.recordQueueRemoval(request, 'dropped', 'max-retries-exceeded')
              removeIds.add(request.id)
            } else {
              request.nextAttemptAt = Date.now() + this.computeRetryDelay(request)
            }
          }
        }

        await sleep(this.jitterRange(this.categoryBudgets[request.category].replayDelayMs))
      }

      if (removeIds.size > 0) {
        this.queue = this.queue.filter((request) => !removeIds.has(request.id))
      }
      this.refreshPendingStats()
      await this.persist()
      logger.info({ remaining: this.queue.length }, 'Queue flush completed')
    } finally {
      this.isFlushing = false
      this.scheduleNextFlush()
    }
  }

  private async executeRequest(httpClient: any, request: QueuedRequest): Promise<void> {
    const { method, url, data, headers } = request

    switch (method) {
      case 'GET':
        await httpClient.get(url, { headers })
        break
      case 'POST':
        await httpClient.post(url, data, { headers })
        break
      case 'PUT':
        await httpClient.put(url, data, { headers })
        break
      case 'DELETE':
        await httpClient.delete(url, { headers })
        break
    }
  }

  private startPeriodicFlush(): void {
    this.scheduleNextFlush(this.queue.length > 0 ? 3000 : undefined)
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  getSize(): number {
    return this.queue.length
  }

  getQueue(): QueuedRequest[] {
    return this.queue.map((request) => ({ ...request }))
  }

  getStats(): RequestQueueStats {
    return JSON.parse(JSON.stringify(this.stats))
  }

  getBudgetSnapshot(): RequestQueueBudgetSnapshot {
    return {
      totalMaxItems: REQUEST_QUEUE_TOTAL_MAX_ITEMS,
      totalMaxBytes: this.totalMaxBytes,
      categories: JSON.parse(JSON.stringify(this.categoryBudgets)),
    }
  }

  getOldestAgeSeconds(): RequestQueueOldestAgeSeconds {
    const oldestAgeByCategory: RequestQueueOldestAgeSeconds = {
      all: 0,
      heartbeat: 0,
      screenshot: 0,
      'command-ack': 0,
      default: 0,
    }

    const now = Date.now()
    for (const entry of this.queue) {
      const ageSeconds = Math.max(0, (now - entry.timestamp) / 1000)
      oldestAgeByCategory.all = Math.max(oldestAgeByCategory.all, ageSeconds)
      oldestAgeByCategory[entry.category] = Math.max(oldestAgeByCategory[entry.category], ageSeconds)
    }

    return oldestAgeByCategory
  }

  async clear(): Promise<void> {
    logger.warn('Clearing request queue')
    this.queue = []
    this.refreshPendingStats()
    await this.persist()
  }

  async cleanup(): Promise<void> {
    this.stopPeriodicFlush()
    await this.persist()
  }
}

let requestQueue: RequestQueue | null = null

export function getRequestQueue(): RequestQueue {
  if (!requestQueue) {
    requestQueue = new RequestQueue()
  }
  return requestQueue
}
