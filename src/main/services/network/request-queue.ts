/**
 * Request Queue - Offline request queue with persistence
 * Queues requests when offline and flushes when connectivity is restored
 */

import * as fs from 'fs'
import * as path from 'path'
import { getLogger } from '../../../common/logger'
import { getConfigManager } from '../../../common/config'
import { DeviceApiError } from '../../../common/types'
import { atomicWrite, ensureDir } from '../../../common/utils'
import { getHttpClient } from './http-client'
import { getLifecycleEvents } from '../lifecycle-events'

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
}

export class RequestQueue {
  private queue: QueuedRequest[] = []
  private queuePath: string
  private maxQueueSize = 1000
  private flushInterval?: NodeJS.Timeout
  private isFlushing = false

  constructor() {
    const config = getConfigManager().getConfig()
    this.queuePath = path.join(config.cache.path, 'request-queue.json')
    ensureDir(path.dirname(this.queuePath), 0o755)

    // Load persisted queue
    this.loadQueue()

    // Start periodic flush
    this.startPeriodicFlush()

    logger.info({ queuePath: this.queuePath, queueSize: this.queue.length }, 'Request queue initialized')
  }

  /**
   * Load queue from disk
   */
  private loadQueue(): void {
    try {
      if (fs.existsSync(this.queuePath)) {
        const data = fs.readFileSync(this.queuePath, 'utf-8')
        this.queue = JSON.parse(data)
        logger.info({ count: this.queue.length }, 'Loaded persisted request queue')
      }
    } catch (error) {
      logger.error({ error }, 'Failed to load request queue')
      this.queue = []
    }
  }

  /**
   * Save queue to disk
   */
  private async saveQueue(): Promise<void> {
    try {
      await atomicWrite(this.queuePath, JSON.stringify(this.queue, null, 2))
    } catch (error) {
      logger.error({ error }, 'Failed to save request queue')
    }
  }

  /**
   * Add request to queue
   */
  async enqueue(request: Omit<QueuedRequest, 'id' | 'timestamp' | 'retries'>): Promise<void> {
    if (this.queue.length >= this.maxQueueSize) {
      logger.warn('Request queue full, dropping oldest request')
      this.queue.shift()
    }

    const queuedRequest: QueuedRequest = {
      ...request,
      id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      retries: 0,
    }

    this.queue.push(queuedRequest)
    await this.saveQueue()

    logger.debug({ id: queuedRequest.id, method: request.method, url: request.url }, 'Request queued')
  }

  /**
   * Flush queue - send all queued requests
   */
  async flush(): Promise<void> {
    if (this.isFlushing) {
      logger.debug('Already flushing queue')
      return
    }

    if (this.queue.length === 0) {
      return
    }

    this.isFlushing = true
    logger.info({ count: this.queue.length }, 'Flushing request queue')

    const httpClient = getHttpClient()
    const failedRequests: QueuedRequest[] = []

    for (const request of this.queue) {
      try {
        await this.executeRequest(httpClient, request)
        logger.debug({ id: request.id, method: request.method, url: request.url }, 'Request executed successfully')
      } catch (error) {
        logger.warn({ id: request.id, error }, 'Request execution failed')

        if (error instanceof DeviceApiError && (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')) {
          getLifecycleEvents().emitRuntimeAuthFailure({
            source: 'request-queue',
            error,
          })
          logger.warn({ id: request.id, code: error.code }, 'Dropping queued request after auth failure')
          continue
        }

        request.retries++
        if (request.retries < request.maxRetries) {
          failedRequests.push(request)
        } else {
          logger.error({ id: request.id, retries: request.retries }, 'Request exceeded max retries, dropping')
        }
      }
    }

    this.queue = failedRequests
    await this.saveQueue()

    this.isFlushing = false
    logger.info({ remaining: this.queue.length }, 'Queue flush completed')
  }

  /**
   * Execute a single request
   */
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

  /**
   * Start periodic flush
   */
  private startPeriodicFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flush().catch((error) => {
        logger.error({ error }, 'Periodic flush failed')
      })
    }, 60000) // Flush every minute
  }

  /**
   * Stop periodic flush
   */
  stopPeriodicFlush(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = undefined
    }
  }

  /**
   * Get queue size
   */
  getSize(): number {
    return this.queue.length
  }

  /**
   * Get queue contents
   */
  getQueue(): QueuedRequest[] {
    return [...this.queue]
  }

  /**
   * Clear queue
   */
  async clear(): Promise<void> {
    logger.warn('Clearing request queue')
    this.queue = []
    await this.saveQueue()
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    this.stopPeriodicFlush()
    await this.saveQueue()
  }
}

// Singleton instance
let requestQueue: RequestQueue | null = null

export function getRequestQueue(): RequestQueue {
  if (!requestQueue) {
    requestQueue = new RequestQueue()
  }
  return requestQueue
}
