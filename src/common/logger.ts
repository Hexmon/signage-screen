/**
 * Structured logging with Pino
 * Features: JSON format, PII redaction, correlation IDs, rotation, compression
 */

import pino from 'pino'
import * as fs from 'fs'
import * as path from 'path'
import { getConfigManager } from './config'

// PII patterns to redact
const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // Email
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b\d{16}\b/g, // Credit card
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, // IP addresses (optional, may want to keep for diagnostics)
]

function redactPII(obj: unknown, seen: WeakSet<object> = new WeakSet(), depth: number = 0): unknown {
  if (depth > 6) {
    return '[MaxDepth]'
  }

  if (typeof obj === 'string') {
    let redacted = obj
    for (const pattern of PII_PATTERNS) {
      redacted = redacted.replace(pattern, '[REDACTED]')
    }
    return redacted
  }

  if (Buffer.isBuffer(obj)) {
    return `[Buffer length=${obj.length}]`
  }

  if (obj instanceof Date) {
    return obj.toISOString()
  }

  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: obj.message,
      stack: obj.stack,
    }
  }

  if (Array.isArray(obj)) {
    if (seen.has(obj)) {
      return '[Circular]'
    }
    seen.add(obj)
    return obj.map((item) => redactPII(item, seen, depth + 1))
  }

  if (obj && typeof obj === 'object') {
    if (seen.has(obj)) {
      return '[Circular]'
    }
    seen.add(obj)
    const redacted: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      // Redact sensitive keys
      if (['password', 'secret', 'token', 'apiKey', 'accessKey', 'secretKey'].includes(key)) {
        redacted[key] = '[REDACTED]'
      } else {
        redacted[key] = redactPII(value, seen, depth + 1)
      }
    }
    return redacted
  }

  return obj
}

function safeRedact(obj: unknown): unknown {
  try {
    return redactPII(obj)
  } catch (error) {
    return {
      error: 'RedactionFailed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

export class Logger {
  private logger: pino.Logger
  private logDir: string
  private currentLogFile: string
  private rotationTimer?: NodeJS.Timeout

  constructor(name: string, logDir?: string) {
    const config = getConfigManager().getConfig()
    this.logDir = logDir || path.join(config.cache.path, 'logs')

    // Ensure log directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true, mode: 0o755 })
    }

    this.currentLogFile = this.getLogFilePath()

    // Determine if we should also log to console (development mode)
    const isDevelopment = process.env['NODE_ENV'] === 'development'

    // Create pino logger configuration
    const pinoConfig = {
      name,
      level: config.log.level,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label: string) => {
          return { level: label }
        },
      },
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
      redact: {
        paths: ['password', 'secret', 'token', 'apiKey', 'accessKey', 'secretKey'],
        remove: true,
      },
    }

    // In development, log to console only to avoid sonic-boom issues
    if (isDevelopment) {
      this.logger = pino(pinoConfig, process.stdout)
    } else {
      // In production, log to file
      this.logger = pino(
        pinoConfig,
        pino.destination({
          dest: this.currentLogFile,
          sync: false,
          mkdir: true,
        })
      )
    }

    // Setup log rotation
    this.setupRotation()
  }

  private getLogFilePath(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0]
    return path.join(this.logDir, `hexmon-${timestamp}.log`)
  }

  private setupRotation(): void {
    const config = getConfigManager().getConfig()
    const rotationIntervalMs = config.log.rotationIntervalHours * 60 * 60 * 1000

    this.rotationTimer = setInterval(() => {
      this.rotate()
    }, rotationIntervalMs)
  }

  private rotate(): void {
    const config = getConfigManager().getConfig()
    const oldLogFile = this.currentLogFile
    this.currentLogFile = this.getLogFilePath()

    // Compress old log if enabled
    if (config.log.compressionEnabled && fs.existsSync(oldLogFile)) {
      this.compressLog(oldLogFile).catch((error) => {
        this.logger.error({ error }, 'Failed to compress log file')
      })
    }

    // Clean up old logs (keep last 30 days)
    this.cleanupOldLogs(30).catch((error) => {
      this.logger.error({ error }, 'Failed to cleanup old logs')
    })
  }

  private async compressLog(logFile: string): Promise<void> {
    const { createGzip } = await import('zlib')
    const { pipeline } = await import('stream/promises')

    const gzip = createGzip()
    const source = fs.createReadStream(logFile)
    const destination = fs.createWriteStream(`${logFile}.gz`)

    await pipeline(source, gzip, destination)
    fs.unlinkSync(logFile) // Remove original after compression
  }

  private async cleanupOldLogs(daysToKeep: number): Promise<void> {
    const files = fs.readdirSync(this.logDir)
    const now = Date.now()
    const maxAge = daysToKeep * 24 * 60 * 60 * 1000

    for (const file of files) {
      const filePath = path.join(this.logDir, file)
      const stats = fs.statSync(filePath)

      if (now - stats.mtimeMs > maxAge) {
        fs.unlinkSync(filePath)
        this.logger.info({ file }, 'Deleted old log file')
      }
    }
  }

  public trace(obj: object, msg?: string): void
  public trace(msg: string): void
  public trace(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.trace(objOrMsg)
    } else {
      this.logger.trace(safeRedact(objOrMsg), msg)
    }
  }

  public debug(obj: object, msg?: string): void
  public debug(msg: string): void
  public debug(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.debug(objOrMsg)
    } else {
      this.logger.debug(safeRedact(objOrMsg), msg)
    }
  }

  public info(obj: object, msg?: string): void
  public info(msg: string): void
  public info(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.info(objOrMsg)
    } else {
      this.logger.info(safeRedact(objOrMsg), msg)
    }
  }

  public warn(obj: object, msg?: string): void
  public warn(msg: string): void
  public warn(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.warn(objOrMsg)
    } else {
      this.logger.warn(safeRedact(objOrMsg), msg)
    }
  }

  public error(obj: object, msg?: string): void
  public error(msg: string): void
  public error(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.error(objOrMsg)
    } else {
      this.logger.error(safeRedact(objOrMsg), msg)
    }
  }

  public fatal(obj: object, msg?: string): void
  public fatal(msg: string): void
  public fatal(objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.logger.fatal(objOrMsg)
    } else {
      this.logger.fatal(safeRedact(objOrMsg), msg)
    }
  }

  public child(bindings: object): Logger {
    const childLogger = new Logger(this.logger.bindings()['name'] as string, this.logDir)
    childLogger.logger = this.logger.child(safeRedact(bindings) as pino.Bindings)
    return childLogger
  }

  public getLogDir(): string {
    return this.logDir
  }

  public getCurrentLogFile(): string {
    return this.currentLogFile
  }

  public destroy(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer)
    }
  }
}

// Logger factory
const loggers = new Map<string, Logger>()

export function getLogger(name: string, logDir?: string): Logger {
  const key = `${name}:${logDir || 'default'}`
  if (!loggers.has(key)) {
    loggers.set(key, new Logger(name, logDir))
  }
  return loggers.get(key)!
}

export function destroyAllLoggers(): void {
  for (const logger of loggers.values()) {
    logger.destroy()
  }
  loggers.clear()
}
