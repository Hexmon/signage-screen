import { app } from 'electron'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { Command, CommandResult, CommandType, DeviceApiError } from '../../common/types'
import { ExponentialBackoff } from '../../common/utils'
import { getHttpClient } from './network/http-client'
import { getRequestQueue } from './network/request-queue'
import { getPairingService } from './pairing-service'
import { getSnapshotManager } from './snapshot-manager'
import { getCacheManager } from './cache/cache-manager'
import { getScreenshotService } from './screenshot-service'
import { getDeviceStateStore } from './device-state-store'
import { getLifecycleEvents } from './lifecycle-events'
import { getDefaultMediaService } from './settings/default-media-service'

const logger = getLogger('command-processor')

type CommandSource = 'heartbeat' | 'poll'

const HEARTBEAT_STALE_MULTIPLIER = 2
const HEALTHY_RECHECK_MIN_MS = 1000
const FALLBACK_POLL_JITTER_FACTOR = 0.2
const HEALTHY_PASSIVE_POLL_JITTER_FACTOR = 0.1

export class CommandProcessor {
  private pollTimer?: NodeJS.Timeout
  private isPolling = false
  private processingCommands = new Set<string>()
  private commandHistory: Map<string, CommandResult> = new Map()
  private maxHistorySize = 100
  private rateLimitMap: Map<CommandType, number> = new Map()
  private rateLimitWindowMs = 60000
  private fallbackPollBackoff = this.createFallbackPollBackoff()

  start(): void {
    if (this.isPolling) {
      return
    }

    this.isPolling = true
    this.fallbackPollBackoff = this.createFallbackPollBackoff()
    this.scheduleNextEvaluation(0)
  }

  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    this.isPolling = false
    this.fallbackPollBackoff = this.createFallbackPollBackoff()
  }

  async ingestCommands(rawCommands: Command[], source: CommandSource): Promise<void> {
    for (const rawCommand of rawCommands) {
      const command = this.normalizeCommand(rawCommand)
      if (getDeviceStateStore().hasRecentCommand(command.id)) {
        logger.debug({ commandId: command.id, source }, 'Skipping previously seen command')
        continue
      }

      await getDeviceStateStore().recordCommandSeen(command.id, source)
      await this.processCommand(command)
    }
  }

  private async pollCommands(): Promise<void> {
    const deviceId = getPairingService().getDeviceId()
    if (!deviceId) {
      return
    }

    try {
      const httpClient = getHttpClient()
      const response = await httpClient.get<{ commands: Command[] }>(`/api/v1/device/${deviceId}/commands`, {
        retryPolicy: {
          maxAttempts: 3,
          baseDelayMs: 2000,
          maxDelayMs: 30000,
        },
      })
      await this.ingestCommands(response.commands || [], 'poll')
    } catch (error) {
      if (error instanceof DeviceApiError && (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')) {
        getLifecycleEvents().emitRuntimeAuthFailure({
          source: 'command-poll',
          error,
        })
        return
      }

      logger.error({ error }, 'Failed to poll commands')
      throw error
    }
  }

  private scheduleNextEvaluation(delayMs: number): void {
    if (!this.isPolling) {
      return
    }

    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
    }

    this.pollTimer = setTimeout(() => {
      void this.evaluatePollingState()
    }, Math.max(0, Math.round(delayMs)))
  }

  private async evaluatePollingState(): Promise<void> {
    if (!this.isPolling) {
      return
    }

    const healthyDelayMs = this.getHealthyHeartbeatDelay()
    const shouldPollWithHealthyHeartbeat = healthyDelayMs > 0 && this.shouldPollWithHealthyHeartbeat()

    if (healthyDelayMs > 0 && !shouldPollWithHealthyHeartbeat) {
      this.fallbackPollBackoff.reset()
      this.scheduleNextEvaluation(healthyDelayMs)
      return
    }

    try {
      await this.pollCommands()
      this.fallbackPollBackoff.reset()
      this.scheduleNextEvaluation(
        shouldPollWithHealthyHeartbeat ? this.getHealthyPassivePollDelay() : this.fallbackPollBackoff.getDelay()
      )
    } catch {
      this.scheduleNextEvaluation(this.fallbackPollBackoff.getDelay())
    }
  }

  private getHealthyHeartbeatDelay(): number {
    const config = getConfigManager().getConfig()
    const staleAfterMs = Math.max(config.intervals.heartbeatMs * HEARTBEAT_STALE_MULTIPLIER, config.intervals.commandPollMs)
    const lastHeartbeatAt = getDeviceStateStore().getState().lastHeartbeatAt
    if (!lastHeartbeatAt) {
      return 0
    }

    const lastHeartbeatTs = Date.parse(lastHeartbeatAt)
    if (Number.isNaN(lastHeartbeatTs)) {
      return 0
    }

    const ageMs = Date.now() - lastHeartbeatTs
    if (ageMs >= staleAfterMs) {
      return 0
    }

    return Math.max(staleAfterMs - ageMs, HEALTHY_RECHECK_MIN_MS)
  }

  private createFallbackPollBackoff(): ExponentialBackoff {
    const config = getConfigManager().getConfig()
    const baseDelayMs = Math.max(config.intervals.commandPollMs, 5000)
    const maxDelayMs = Math.max(baseDelayMs * 4, config.intervals.heartbeatMs * 4, 60000)
    return new ExponentialBackoff(baseDelayMs, maxDelayMs, 10, FALLBACK_POLL_JITTER_FACTOR)
  }

  private shouldPollWithHealthyHeartbeat(): boolean {
    const mode = getSnapshotManager().getCurrentPlaylist()?.mode
    return mode === 'default' || mode === 'empty' || mode === 'offline'
  }

  private getHealthyPassivePollDelay(): number {
    const config = getConfigManager().getConfig()
    const baseDelayMs = Math.max(config.intervals.commandPollMs, 5000)
    const jitter = baseDelayMs * HEALTHY_PASSIVE_POLL_JITTER_FACTOR * (Math.random() * 2 - 1)
    return Math.max(0, Math.round(baseDelayMs + jitter))
  }

  private normalizeCommand(command: Command): Command {
    const payload = command.params || (command as unknown as { payload?: Record<string, unknown> }).payload
    let type = command.type
    if (type === 'TAKE_SCREENSHOT') {
      type = 'SCREENSHOT'
    }
    return {
      ...command,
      type,
      params: payload,
    }
  }

  private async processCommand(command: Command): Promise<void> {
    if (this.processingCommands.has(command.id)) {
      return
    }

    if (this.isRateLimited(command.type)) {
      await this.acknowledgeCommand(command.id, {
        success: false,
        error: 'Rate limited',
        timestamp: new Date().toISOString(),
      })
      return
    }

    this.processingCommands.add(command.id)

    try {
      let result: CommandResult

      switch (command.type) {
        case 'REBOOT':
          result = await this.handleReboot()
          break
        case 'REFRESH':
        case 'REFRESH_SCHEDULE':
          result = await this.handleRefreshSchedule()
          break
        case 'SCREENSHOT':
          result = await this.handleScreenshot()
          break
        case 'SET_SCREENSHOT_INTERVAL':
          result = await this.handleSetScreenshotInterval(command)
          break
        case 'TEST_PATTERN':
          result = await this.handleTestPattern()
          break
        case 'CLEAR_CACHE':
          result = await this.handleClearCache(command)
          break
        case 'PING':
          result = await this.handlePing()
          break
        default:
          result = {
            success: false,
            error: `Unknown command type: ${command.type}`,
            timestamp: new Date().toISOString(),
          }
      }

      this.commandHistory.set(command.id, result)
      if (this.commandHistory.size > this.maxHistorySize) {
        const oldest = this.commandHistory.keys().next().value
        if (oldest) {
          this.commandHistory.delete(oldest)
        }
      }

      await this.acknowledgeCommand(command.id, result)
      this.updateRateLimit(command.type)
    } catch (error) {
      logger.error({ error, commandId: command.id }, 'Command processing failed')
      await this.acknowledgeCommand(command.id, {
        success: false,
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      })
    } finally {
      this.processingCommands.delete(command.id)
    }
  }

  private async handleReboot(): Promise<CommandResult> {
    setTimeout(() => {
      app.relaunch()
      app.quit()
    }, 2000)

    return {
      success: true,
      message: 'Reboot initiated',
      timestamp: new Date().toISOString(),
    }
  }

  private async handleRefreshSchedule(): Promise<CommandResult> {
    await getSnapshotManager().refreshSnapshot()
    try {
      await getDefaultMediaService().refreshNow('refresh-command')
    } catch (error) {
      logger.warn({ error }, 'Default media refresh failed during schedule refresh command')
    }
    return {
      success: true,
      message: 'Schedule refreshed',
      timestamp: new Date().toISOString(),
    }
  }

  private async handleScreenshot(): Promise<CommandResult> {
    const objectKey = await getScreenshotService().captureAndUpload()
    return {
      success: true,
      message: 'Screenshot captured',
      data: { objectKey },
      timestamp: new Date().toISOString(),
    }
  }

  private async handleSetScreenshotInterval(command: Command): Promise<CommandResult> {
    const screenshotService = getScreenshotService()
    const enabledParam = command.params?.['enabled']
    const enabled = typeof enabledParam === 'boolean' ? enabledParam : true

    const rawIntervalSeconds = command.params?.['interval_seconds']
    const rawIntervalMilliseconds = command.params?.['interval_ms'] ?? command.params?.['intervalMs']
    const appliedPolicy = screenshotService.applyPolicy({
      enabled,
      interval_seconds: typeof rawIntervalSeconds === 'number' ? rawIntervalSeconds : null,
      interval_ms: typeof rawIntervalMilliseconds === 'number' ? rawIntervalMilliseconds : null,
    })

    if (!enabled) {
      return {
        success: true,
        message: 'Screenshot capture disabled',
        timestamp: new Date().toISOString(),
      }
    }

    if (!appliedPolicy.intervalMs) {
      return {
        success: false,
        error: 'Missing screenshot interval',
        timestamp: new Date().toISOString(),
      }
    }

    return {
      success: true,
      message: `Screenshot interval updated to ${appliedPolicy.intervalMs}ms`,
      timestamp: new Date().toISOString(),
    }
  }

  private async handleTestPattern(): Promise<CommandResult> {
    return {
      success: true,
      message: 'Test pattern command acknowledged',
      timestamp: new Date().toISOString(),
    }
  }

  private async handleClearCache(command: Command): Promise<CommandResult> {
    const force = command.params?.['force'] === true
    await getCacheManager().clear(force)
    return {
      success: true,
      message: 'Cache cleared',
      timestamp: new Date().toISOString(),
    }
  }

  private async handlePing(): Promise<CommandResult> {
    return {
      success: true,
      message: 'Pong',
      data: {
        uptime: process.uptime(),
        version: app.getVersion(),
      },
      timestamp: new Date().toISOString(),
    }
  }

  private async acknowledgeCommand(commandId: string, result: CommandResult): Promise<void> {
    const deviceId = getPairingService().getDeviceId()
    if (!deviceId) {
      return
    }

    try {
      const httpClient = getHttpClient()
      await httpClient.post(`/api/v1/device/${deviceId}/commands/${commandId}/ack`, {}, {
        retryPolicy: {
          maxAttempts: 3,
          baseDelayMs: 2000,
          maxDelayMs: 30000,
        },
      })
      await getDeviceStateStore().recordCommandAcknowledged(commandId)
      logger.debug({ commandId, success: result.success }, 'Command acknowledged')
    } catch (error) {
      if (error instanceof DeviceApiError && (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')) {
        getLifecycleEvents().emitRuntimeAuthFailure({
          source: 'command-ack',
          error,
        })
        return
      }

      const requestQueue = getRequestQueue()
      await requestQueue.enqueue({
        method: 'POST',
        url: `/api/v1/device/${deviceId}/commands/${commandId}/ack`,
        data: {},
        maxRetries: 3,
      })
    }
  }

  private shouldSkipRateLimit(commandType: CommandType): boolean {
    return commandType === 'REFRESH' || commandType === 'REFRESH_SCHEDULE'
  }

  private isRateLimited(commandType: CommandType): boolean {
    if (this.shouldSkipRateLimit(commandType)) {
      return false
    }

    const lastExecution = this.rateLimitMap.get(commandType)
    return lastExecution !== undefined && Date.now() - lastExecution < this.rateLimitWindowMs
  }

  private updateRateLimit(commandType: CommandType): void {
    if (this.shouldSkipRateLimit(commandType)) {
      return
    }

    this.rateLimitMap.set(commandType, Date.now())
  }

  getCommandHistory(): Map<string, CommandResult> {
    return new Map(this.commandHistory)
  }

  isProcessing(commandId: string): boolean {
    return this.processingCommands.has(commandId)
  }
}

let commandProcessor: CommandProcessor | null = null

export function getCommandProcessor(): CommandProcessor {
  if (!commandProcessor) {
    commandProcessor = new CommandProcessor()
  }
  return commandProcessor
}
