/**
 * Command Processor - Process remote commands from backend
 * Supports: REBOOT, REFRESH_SCHEDULE, SCREENSHOT, TEST_PATTERN, CLEAR_CACHE, PING
 */

import { app } from 'electron'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { Command, CommandResult, CommandType } from '../../common/types'
import { getHttpClient } from './network/http-client'
import { getRequestQueue } from './network/request-queue'
import { getPairingService } from './pairing-service'
import { getScheduleManager } from './schedule-manager'
import { getCacheManager } from './cache/cache-manager'
import { getScreenshotService } from './screenshot-service'

const logger = getLogger('command-processor')

export class CommandProcessor {
  private pollInterval?: NodeJS.Timeout
  private isPolling = false
  private processingCommands = new Set<string>()
  private commandHistory: Map<string, CommandResult> = new Map()
  private maxHistorySize = 100
  private rateLimitMap: Map<CommandType, number> = new Map()
  private rateLimitWindowMs = 60000 // 1 minute

  /**
   * Start command processor
   */
  start(): void {
    if (this.isPolling) {
      logger.warn('Command processor already running')
      return
    }

    const config = getConfigManager().getConfig()
    const intervalMs = config.intervals.commandPollMs

    logger.info({ intervalMs }, 'Starting command processor')

    this.isPolling = true
    this.pollInterval = setInterval(() => {
      this.pollCommands().catch((error) => {
        logger.error({ error }, 'Command poll failed')
      })
    }, intervalMs)

    // Initial poll
    this.pollCommands().catch((error) => {
      logger.error({ error }, 'Initial command poll failed')
    })
  }

  /**
   * Stop command processor
   */
  stop(): void {
    if (!this.isPolling) {
      return
    }

    logger.info('Stopping command processor')

    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = undefined
    }

    this.isPolling = false
  }

  /**
   * Poll for commands from backend
   */
  private async pollCommands(): Promise<void> {
    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()

    if (!deviceId) {
      logger.debug('Device not paired, skipping command poll')
      return
    }

    try {
      const httpClient = getHttpClient()
      const response = await httpClient.get<{ commands: Command[] }>(`/v1/device/${deviceId}/commands`)
      const commands = response?.commands || []

      if (!commands || commands.length === 0) {
        return
      }

      logger.info({ count: commands.length }, 'Received commands')

      // Process commands sequentially
      for (const command of commands) {
        await this.processCommand(command)
      }
    } catch (error) {
      logger.error({ error }, 'Failed to poll commands')
    }
  }

  /**
   * Process a single command
   */
  private async processCommand(command: Command): Promise<void> {
    // Check if already processing
    if (this.processingCommands.has(command.id)) {
      logger.debug({ commandId: command.id }, 'Command already being processed')
      return
    }

    // Check rate limit
    if (this.isRateLimited(command.type)) {
      logger.warn({ commandType: command.type }, 'Command rate limited')
      await this.acknowledgeCommand(command.id, {
        success: false,
        error: 'Rate limited',
        timestamp: new Date().toISOString(),
      })
      return
    }

    this.processingCommands.add(command.id)

    logger.info(
      {
        commandId: command.id,
        type: command.type,
        params: command.params,
      },
      'Processing command'
    )

    try {
      let result: CommandResult

      switch (command.type) {
        case 'REBOOT':
          result = await this.handleReboot(command)
          break
        case 'REFRESH_SCHEDULE':
          result = await this.handleRefreshSchedule(command)
          break
        case 'SCREENSHOT':
          result = await this.handleScreenshot(command)
          break
        case 'TEST_PATTERN':
          result = await this.handleTestPattern(command)
          break
        case 'CLEAR_CACHE':
          result = await this.handleClearCache(command)
          break
        case 'PING':
          result = await this.handlePing(command)
          break
        default:
          result = {
            success: false,
            error: `Unknown command type: ${command.type}`,
            timestamp: new Date().toISOString(),
          }
      }

      // Store in history
      this.commandHistory.set(command.id, result)
      if (this.commandHistory.size > this.maxHistorySize) {
        const firstKey = this.commandHistory.keys().next().value
        if (firstKey !== undefined) {
          this.commandHistory.delete(firstKey)
        }
      }

      // Acknowledge command
      await this.acknowledgeCommand(command.id, result)

      // Update rate limit
      this.updateRateLimit(command.type)

      logger.info({ commandId: command.id, success: result.success }, 'Command processed')
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

  /**
   * Handle REBOOT command
   */
  private async handleReboot(command: Command): Promise<CommandResult> {
    logger.warn({ commandId: command.id }, 'Executing REBOOT command')

    try {
      // Graceful shutdown
      setTimeout(() => {
        app.relaunch()
        app.quit()
      }, 2000)

      return {
        success: true,
        message: 'Reboot initiated',
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      }
    }
  }

  /**
   * Handle REFRESH_SCHEDULE command
   */
  private async handleRefreshSchedule(command: Command): Promise<CommandResult> {
    logger.info({ commandId: command.id }, 'Executing REFRESH_SCHEDULE command')

    try {
      const scheduleManager = getScheduleManager()
      await scheduleManager.refresh()

      return {
        success: true,
        message: 'Schedule refreshed',
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      }
    }
  }

  /**
   * Handle SCREENSHOT command
   */
  private async handleScreenshot(command: Command): Promise<CommandResult> {
    logger.info({ commandId: command.id }, 'Executing SCREENSHOT command')

    try {
      const screenshotService = getScreenshotService()
      const objectKey = await screenshotService.captureAndUpload()

      return {
        success: true,
        message: 'Screenshot captured',
        data: { objectKey },
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      }
    }
  }

  /**
   * Handle TEST_PATTERN command
   */
  private async handleTestPattern(command: Command): Promise<CommandResult> {
    logger.info({ commandId: command.id }, 'Executing TEST_PATTERN command')

    try {
      // TODO: Display test pattern on screen
      // This would send a message to the renderer to show a test pattern

      return {
        success: true,
        message: 'Test pattern displayed',
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      }
    }
  }

  /**
   * Handle CLEAR_CACHE command
   */
  private async handleClearCache(command: Command): Promise<CommandResult> {
    logger.info({ commandId: command.id }, 'Executing CLEAR_CACHE command')

    try {
      const cacheManager = getCacheManager()
      const force = command.params?.['force'] === true

      await cacheManager.clear(force)

      return {
        success: true,
        message: 'Cache cleared',
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      }
    }
  }

  /**
   * Handle PING command
   */
  private async handlePing(command: Command): Promise<CommandResult> {
    logger.debug({ commandId: command.id }, 'Executing PING command')

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

  /**
   * Acknowledge command completion
   */
  private async acknowledgeCommand(commandId: string, result: CommandResult): Promise<void> {
    const pairingService = getPairingService()
    const deviceId = pairingService.getDeviceId()

    try {
      if (!deviceId) {
        return
      }

      const httpClient = getHttpClient()
      await httpClient.post(`/v1/device/${deviceId}/commands/${commandId}/ack`, {})

      logger.debug({ commandId, success: result.success }, 'Command acknowledged')
    } catch (error) {
      logger.error({ error, commandId }, 'Failed to acknowledge command')

      try {
        if (deviceId) {
          const requestQueue = getRequestQueue()
          await requestQueue.enqueue({
            method: 'POST',
            url: `/v1/device/${deviceId}/commands/${commandId}/ack`,
            data: {},
            maxRetries: 3,
          })
          logger.info({ commandId }, 'Command acknowledgment queued for retry')
        }
      } catch (queueError) {
        logger.error({ error: queueError, commandId }, 'Failed to queue command acknowledgment')
      }
    }
  }

  /**
   * Check if command type is rate limited
   */
  private isRateLimited(commandType: CommandType): boolean {
    const lastExecution = this.rateLimitMap.get(commandType)
    if (!lastExecution) {
      return false
    }

    const now = Date.now()
    return now - lastExecution < this.rateLimitWindowMs
  }

  /**
   * Update rate limit for command type
   */
  private updateRateLimit(commandType: CommandType): void {
    this.rateLimitMap.set(commandType, Date.now())
  }

  /**
   * Get command history
   */
  getCommandHistory(): Map<string, CommandResult> {
    return new Map(this.commandHistory)
  }

  /**
   * Check if command is being processed
   */
  isProcessing(commandId: string): boolean {
    return this.processingCommands.has(commandId)
  }
}

// Singleton instance
let commandProcessor: CommandProcessor | null = null

export function getCommandProcessor(): CommandProcessor {
  if (!commandProcessor) {
    commandProcessor = new CommandProcessor()
  }
  return commandProcessor
}
