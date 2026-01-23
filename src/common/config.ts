/**
 * Configuration management with JSON + environment variables
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AppConfig } from './types'

const isDevelopment = process.env['NODE_ENV'] === 'development'
const homeDir = os.homedir() || '/tmp'

const DEFAULT_CACHE_PATH =
  process.env['HEXMON_CACHE_PATH'] || (isDevelopment ? path.join(homeDir, '.hexmon', 'cache') : '/var/cache/hexmon')

const DEFAULT_CERT_DIR =
  process.env['HEXMON_MTLS_CERT_DIR'] || (isDevelopment ? path.join(homeDir, '.hexmon', 'certs') : '/var/lib/hexmon/certs')

const DEFAULT_CERT_PATH = process.env['HEXMON_MTLS_CERT_PATH'] || path.join(DEFAULT_CERT_DIR, 'client.crt')
const DEFAULT_KEY_PATH = process.env['HEXMON_MTLS_KEY_PATH'] || path.join(DEFAULT_CERT_DIR, 'client.key')
const DEFAULT_CA_PATH = process.env['HEXMON_MTLS_CA_PATH'] || path.join(DEFAULT_CERT_DIR, 'ca.crt')

const DEFAULT_CONFIG: AppConfig = {
  // Single source of truth for backend URLs is config.json.
  apiBase: isDevelopment ? 'http://192.168.0.3:3000' : 'https://api.hexmon.local',
  wsUrl: isDevelopment ? 'ws://192.168.0.3:3000/ws' : 'wss://api.hexmon.local/ws',
  deviceId: process.env['HEXMON_DEVICE_ID'] || '',
  mtls: {
    enabled: process.env['HEXMON_MTLS_ENABLED'] === 'true',
    certPath: DEFAULT_CERT_PATH,
    keyPath: DEFAULT_KEY_PATH,
    caPath: DEFAULT_CA_PATH,
    autoRenew: process.env['HEXMON_MTLS_AUTO_RENEW'] !== 'false',
    renewBeforeDays: parseInt(process.env['HEXMON_MTLS_RENEW_BEFORE_DAYS'] || '30', 10),
  },
  cache: {
    path: DEFAULT_CACHE_PATH,
    maxBytes: parseInt(process.env['HEXMON_CACHE_MAX_BYTES'] || String(10 * 1024 * 1024 * 1024), 10), // 10GB default
    prefetchConcurrency: parseInt(process.env['HEXMON_CACHE_PREFETCH_CONCURRENCY'] || '3', 10),
    bandwidthBudgetMbps: parseInt(process.env['HEXMON_CACHE_BANDWIDTH_BUDGET_MBPS'] || '50', 10),
  },
  intervals: {
    heartbeatMs: parseInt(process.env['HEXMON_INTERVAL_HEARTBEAT_MS'] || '30000', 10), // 30 seconds
    commandPollMs: parseInt(process.env['HEXMON_INTERVAL_COMMAND_POLL_MS'] || '30000', 10), // 30 seconds
    schedulePollMs: parseInt(process.env['HEXMON_INTERVAL_SCHEDULE_POLL_MS'] || '300000', 10), // 5 minutes
    healthCheckMs: parseInt(process.env['HEXMON_INTERVAL_HEALTH_CHECK_MS'] || '60000', 10), // 1 minute
    screenshotMs: parseInt(process.env['HEXMON_INTERVAL_SCREENSHOT_MS'] || '300000', 10), // 5 minutes
  },
  log: {
    level: (process.env['HEXMON_LOG_LEVEL'] as AppConfig['log']['level']) || 'info',
    shipPolicy: (process.env['HEXMON_LOG_SHIP_POLICY'] as AppConfig['log']['shipPolicy']) || 'batch',
    rotationSizeMb: parseInt(process.env['HEXMON_LOG_ROTATION_SIZE_MB'] || '100', 10),
    rotationIntervalHours: parseInt(process.env['HEXMON_LOG_ROTATION_INTERVAL_HOURS'] || '24', 10),
    compressionEnabled: process.env['HEXMON_LOG_COMPRESSION_ENABLED'] !== 'false',
  },
  power: {
    dpmsEnabled: process.env['HEXMON_POWER_DPMS_ENABLED'] !== 'false',
    preventBlanking: process.env['HEXMON_POWER_PREVENT_BLANKING'] !== 'false',
    scheduleEnabled: process.env['HEXMON_POWER_SCHEDULE_ENABLED'] === 'true',
    onTime: process.env['HEXMON_POWER_ON_TIME'],
    offTime: process.env['HEXMON_POWER_OFF_TIME'],
  },
  security: {
    csp: process.env['HEXMON_SECURITY_CSP'] || "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    allowedDomains: process.env['HEXMON_SECURITY_ALLOWED_DOMAINS']?.split(',') || [],
    disableEval: process.env['HEXMON_SECURITY_DISABLE_EVAL'] !== 'false',
    contextIsolation: process.env['HEXMON_SECURITY_CONTEXT_ISOLATION'] !== 'false',
    nodeIntegration: process.env['HEXMON_SECURITY_NODE_INTEGRATION'] === 'true',
    sandbox: process.env['HEXMON_SECURITY_SANDBOX'] !== 'false',
  },
}

export class ConfigManager {
  private config: AppConfig
  private configPath: string

  constructor(configPath?: string) {
    this.configPath = configPath || this.getDefaultConfigPath()
    this.config = this.loadConfig()
  }

  private getDefaultConfigPath(): string {
    // Try multiple locations in order of preference
    const locations = [
      process.env['HEXMON_CONFIG_PATH'],
      '/etc/hexmon/config.json',
      path.join(process.env['HOME'] || '/root', '.config', 'hexmon', 'config.json'),
      path.join(__dirname, '..', '..', 'config.json'),
    ]

    for (const location of locations) {
      if (location && fs.existsSync(location)) {
        return location
      }
    }

    // Return the first writable location
    return locations[2] || locations[3] || '/tmp/hexmon-config.json'
  }

  private loadConfig(): AppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const fileContent = fs.readFileSync(this.configPath, 'utf-8')
        const fileConfig = JSON.parse(fileContent) as Partial<AppConfig>
        
        // Deep merge with defaults, environment variables take precedence
        return this.mergeConfig(DEFAULT_CONFIG, fileConfig)
      }
    } catch (error) {
      console.error('Failed to load config file, using defaults:', error)
    }

    return DEFAULT_CONFIG
  }

  private mergeConfig(defaults: AppConfig, overrides: Partial<AppConfig>): AppConfig {
    return {
      apiBase: overrides.apiBase || defaults.apiBase,
      wsUrl: overrides.wsUrl || defaults.wsUrl,
      deviceId: overrides.deviceId || defaults.deviceId,
      mtls: { ...defaults.mtls, ...overrides.mtls },
      cache: { ...defaults.cache, ...overrides.cache },
      intervals: { ...defaults.intervals, ...overrides.intervals },
      log: { ...defaults.log, ...overrides.log },
      power: { ...defaults.power, ...overrides.power },
      security: { ...defaults.security, ...overrides.security },
    }
  }

  public getConfig(): AppConfig {
    return { ...this.config }
  }

  public updateConfig(updates: Partial<AppConfig>): void {
    this.config = this.mergeConfig(this.config, updates)
    this.saveConfig()
  }

  public saveConfig(): void {
    try {
      const dir = path.dirname(this.configPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
      }

      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), {
        mode: 0o600, // Secure permissions
      })
    } catch (error) {
      console.error('Failed to save config:', error)
      throw error
    }
  }

  public get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key]
  }

  public set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.config[key] = value
    this.saveConfig()
  }

  public getConfigPath(): string {
    return this.configPath
  }

  public validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Validate required fields
    if (!this.config.apiBase) {
      errors.push('apiBase is required')
    }

    if (!this.config.wsUrl) {
      errors.push('wsUrl is required')
    }

    // Validate URLs
    try {
      new URL(this.config.apiBase)
    } catch {
      errors.push('apiBase must be a valid URL')
    }

    try {
      new URL(this.config.wsUrl)
    } catch {
      errors.push('wsUrl must be a valid URL')
    }

    // Validate cache settings
    if (this.config.cache.maxBytes < 1024 * 1024 * 100) {
      errors.push('cache.maxBytes must be at least 100MB')
    }

    if (this.config.cache.prefetchConcurrency < 1 || this.config.cache.prefetchConcurrency > 10) {
      errors.push('cache.prefetchConcurrency must be between 1 and 10')
    }

    // Validate intervals
    if (this.config.intervals.heartbeatMs < 10000) {
      errors.push('intervals.heartbeatMs must be at least 10 seconds')
    }
    if (this.config.intervals.commandPollMs < 5000) {
      errors.push('intervals.commandPollMs must be at least 5 seconds')
    }
    if (this.config.intervals.schedulePollMs < 10000) {
      errors.push('intervals.schedulePollMs must be at least 10 seconds')
    }
    if (this.config.intervals.screenshotMs < 10000) {
      errors.push('intervals.screenshotMs must be at least 10 seconds')
    }

    // Validate mTLS paths if enabled
    if (this.config.mtls.enabled) {
      const paths = [this.config.mtls.certPath, this.config.mtls.keyPath, this.config.mtls.caPath]
      for (const p of paths) {
        if (!p) {
          errors.push(`mTLS path is required when mTLS is enabled: ${p}`)
        }
      }
    }

    // Validate power schedule times
    if (this.config.power.scheduleEnabled) {
      const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/
      if (this.config.power.onTime && !timeRegex.test(this.config.power.onTime)) {
        errors.push('power.onTime must be in HH:MM format')
      }
      if (this.config.power.offTime && !timeRegex.test(this.config.power.offTime)) {
        errors.push('power.offTime must be in HH:MM format')
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }
}

// Singleton instance
let configManager: ConfigManager | null = null

export function getConfigManager(configPath?: string): ConfigManager {
  if (!configManager) {
    configManager = new ConfigManager(configPath)
  }
  return configManager
}

export function resetConfigManager(): void {
  configManager = null
}
