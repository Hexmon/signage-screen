/**
 * Common utility functions
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Calculate SHA-256 hash of a file
 */
export async function calculateFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)

    stream.on('data', (data) => hash.update(data))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Calculate SHA-256 hash of a buffer
 */
export function calculateBufferHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Atomic file write using temp → rename pattern
 */
export async function atomicWrite(filePath: string, data: Buffer | string): Promise<void> {
  const tempPath = `${filePath}.tmp.${Date.now()}`
  const dir = path.dirname(filePath)

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  }

  try {
    // Write to temp file
    fs.writeFileSync(tempPath, data, { mode: 0o644 })

    // Atomic rename
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    // Cleanup temp file on error
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath)
    }
    throw error
  }
}

/**
 * Bounded exponential backoff calculator
 */
export class ExponentialBackoff {
  private attempt = 0

  constructor(
    private baseDelayMs: number = 1000,
    private maxDelayMs: number = 60000,
    private maxAttempts: number = 10,
    private jitterFactor: number = 0.1
  ) {}

  public getDelay(): number {
    if (this.attempt >= this.maxAttempts) {
      return this.maxDelayMs
    }

    const exponentialDelay = Math.min(this.baseDelayMs * Math.pow(2, this.attempt), this.maxDelayMs)

    // Add jitter to prevent thundering herd
    const jitter = exponentialDelay * this.jitterFactor * (Math.random() * 2 - 1)

    this.attempt++
    return Math.max(0, exponentialDelay + jitter)
  }

  public reset(): void {
    this.attempt = 0
  }

  public getAttempt(): number {
    return this.attempt
  }
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    onRetry?: (attempt: number, error: Error) => void
    shouldRetry?: (attempt: number, error: Error) => boolean
  } = {}
): Promise<T> {
  const backoff = new ExponentialBackoff(
    options.baseDelayMs || 1000,
    options.maxDelayMs || 60000,
    options.maxAttempts || 5
  )

  let lastError: Error | undefined

  while (backoff.getAttempt() < (options.maxAttempts || 5)) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      const attempt = backoff.getAttempt() + 1
      if (options.shouldRetry && !options.shouldRetry(attempt, lastError)) {
        throw lastError
      }
      const delay = backoff.getDelay()

      if (options.onRetry) {
        options.onRetry(backoff.getAttempt(), lastError)
      }

      if (backoff.getAttempt() < (options.maxAttempts || 5)) {
        await sleep(delay)
      }
    }
  }

  throw lastError || new Error('Retry failed')
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

/**
 * Format milliseconds to human-readable duration
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

/**
 * Sanitize filename to prevent path traversal
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .substring(0, 255)
}

/**
 * Check if path is within allowed directory (prevent path traversal)
 */
export function isPathSafe(filePath: string, allowedDir: string): boolean {
  const resolvedPath = path.resolve(filePath)
  const resolvedAllowedDir = path.resolve(allowedDir)
  return resolvedPath.startsWith(resolvedAllowedDir)
}

/**
 * Get disk usage for a path
 */
export async function getDiskUsage(dirPath: string): Promise<{ used: number; total: number; free: number }> {
  // This is a simplified version. For production, use a library like 'diskusage'
  // or call system commands
  try {
    const stats = fs.statfsSync ? fs.statfsSync(dirPath) : null
    if (stats) {
      return {
        total: stats.blocks * stats.bsize,
        free: stats.bfree * stats.bsize,
        used: (stats.blocks - stats.bfree) * stats.bsize,
      }
    }
  } catch (error) {
    // Fallback: calculate directory size
    const used = await getDirectorySize(dirPath)
    return {
      used,
      total: 0,
      free: 0,
    }
  }

  return { used: 0, total: 0, free: 0 }
}

/**
 * Calculate total size of a directory
 */
export async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0

  const walk = (dir: string): void => {
    const files = fs.readdirSync(dir)

    for (const file of files) {
      const filePath = path.join(dir, file)
      const stats = fs.statSync(filePath)

      if (stats.isDirectory()) {
        walk(filePath)
      } else {
        totalSize += stats.size
      }
    }
  }

  if (fs.existsSync(dirPath)) {
    walk(dirPath)
  }

  return totalSize
}

/**
 * Ensure directory exists with proper permissions
 */
export function ensureDir(dirPath: string, mode: number = 0o755): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode })
  }
}

/**
 * Generate a random ID
 */
export function generateId(length: number = 16): string {
  return crypto.randomBytes(length).toString('hex')
}

/**
 * Generate a 6-character pairing code
 */
export function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // Exclude ambiguous characters
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

/**
 * Validate URL against allowed domains
 */
export function isUrlAllowed(url: string, allowedDomains: string[]): boolean {
  try {
    const parsed = new URL(url)
    
    // Allow localhost in development
    if (process.env['NODE_ENV'] === 'development' && parsed.hostname === 'localhost') {
      return true
    }

    // Check against allowed domains
    return allowedDomains.some((domain) => {
      if (domain.startsWith('*.')) {
        // Wildcard subdomain
        const baseDomain = domain.substring(2)
        return parsed.hostname.endsWith(baseDomain)
      }
      return parsed.hostname === domain
    })
  } catch {
    return false
  }
}

/**
 * Parse time string in HH:MM format
 */
export function parseTime(timeStr: string): { hours: number; minutes: number } | null {
  const match = timeStr.match(/^(\d{2}):(\d{2})$/)
  if (!match || !match[1] || !match[2]) return null

  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null
  }

  return { hours, minutes }
}

/**
 * Check if current time is within schedule
 */
export function isWithinSchedule(onTime: string, offTime: string): boolean {
  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()

  const on = parseTime(onTime)
  const off = parseTime(offTime)

  if (!on || !off) return true // If invalid, assume always on

  const onMinutes = on.hours * 60 + on.minutes
  const offMinutes = off.hours * 60 + off.minutes

  if (onMinutes < offMinutes) {
    // Same day schedule (e.g., 08:00 - 18:00)
    return currentMinutes >= onMinutes && currentMinutes < offMinutes
  } else {
    // Overnight schedule (e.g., 18:00 - 08:00)
    return currentMinutes >= onMinutes || currentMinutes < offMinutes
  }
}
