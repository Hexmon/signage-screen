import { app } from 'electron'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { Command, CommandResult, CommandType, DeviceApiError } from '../../common/types'
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

export class CommandProcessor {
  private pollInterval?: NodeJS.Timeout
  private isPolling = false
  private processingCommands = new Set<string>()
  private commandHistory: Map<string, CommandResult> = new Map()
  private maxHistorySize = 100
  private rateLimitMap: Map<CommandType, number> = new Map()
  private rateLimitWindowMs = 60000

  start(): void {
    if (this.isPolling) {
      return
    }

    const config = getConfigManager().getConfig()
    const intervalMs = config.intervals.commandPollMs

    this.isPolling = true
    this.pollInterval = setInterval(() => {
      this.pollCommands().catch((error) => {
        logger.error({ error }, 'Command poll failed')
      })
    }, intervalMs)

    void this.pollCommands()
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = undefined
    }
    this.isPolling = false
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
    }
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
    screenshotService.setCaptureEnabled(enabled)

    const rawIntervalSeconds = command.params?.['interval_seconds']
    const rawIntervalMilliseconds = command.params?.['interval_ms'] ?? command.params?.['intervalMs']
    const intervalMs =
      typeof rawIntervalSeconds === 'number'
        ? Math.max(10000, Math.round(rawIntervalSeconds * 1000))
        : typeof rawIntervalMilliseconds === 'number'
          ? Math.max(10000, Math.round(rawIntervalMilliseconds))
          : undefined

    if (!enabled) {
      return {
        success: true,
        message: 'Screenshot capture disabled',
        timestamp: new Date().toISOString(),
      }
    }

    if (!intervalMs) {
      return {
        success: false,
        error: 'Missing screenshot interval',
        timestamp: new Date().toISOString(),
      }
    }

    getConfigManager().updateConfig({
      intervals: {
        ...getConfigManager().getConfig().intervals,
        screenshotMs: intervalMs,
      },
    })

    return {
      success: true,
      message: `Screenshot interval updated to ${intervalMs}ms`,
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

  private isRateLimited(commandType: CommandType): boolean {
    const lastExecution = this.rateLimitMap.get(commandType)
    return lastExecution !== undefined && Date.now() - lastExecution < this.rateLimitWindowMs
  }

  private updateRateLimit(commandType: CommandType): void {
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
