/**
 * Configuration management persisted to a user-writable JSON file.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { EventEmitter } from 'events'
import type { AppConfig } from './types'
import type { App as ElectronApp } from 'electron'

export class ConfigManager {
  private config: AppConfig
  private readonly configPath: string
  private readonly defaults: AppConfig
  private readonly emitter = new EventEmitter()

  constructor(configPath?: string) {
    this.configPath = configPath || this.getDefaultConfigPath()
    this.defaults = this.buildDefaultConfig()
    this.config = this.loadConfig()
  }

  private getDefaultConfigPath(): string {
    const override = process.env['SIGNAGE_CONFIG_PATH'] || process.env['HEXMON_CONFIG_PATH']
    if (override) return override

    const appInstance = this.getElectronApp()
    if (appInstance) {
      return path.join(appInstance.getPath('userData'), 'config.json')
    }

    const homeDir = os.homedir() || os.tmpdir()
    return path.join(homeDir, '.config', 'hexmon', 'config.json')
  }

  private getElectronApp(): ElectronApp | undefined {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = require('electron') as typeof import('electron')
      if (electron?.app && typeof electron.app.getPath === 'function') {
        return electron.app
      }
    } catch {
      return undefined
    }
    return undefined
  }

  private buildDefaultConfig(): AppConfig {
    const isDevelopment = process.env['NODE_ENV'] === 'development'
    const homeDir = os.homedir() || os.tmpdir()
    const apiBase = this.buildDefaultApiBase()
    const wsUrl = this.buildDefaultWsUrl(apiBase)

    const defaultCachePath =
      process.env['HEXMON_CACHE_PATH'] || (isDevelopment ? path.join(homeDir, '.hexmon', 'cache') : '/var/cache/hexmon')

    const defaultCertDir =
      process.env['HEXMON_MTLS_CERT_DIR'] || (isDevelopment ? path.join(homeDir, '.hexmon', 'certs') : '/var/lib/hexmon/certs')

    const defaultCertPath = process.env['HEXMON_MTLS_CERT_PATH'] || path.join(defaultCertDir, 'client.crt')
    const defaultKeyPath = process.env['HEXMON_MTLS_KEY_PATH'] || path.join(defaultCertDir, 'client.key')
    const defaultCaPath = process.env['HEXMON_MTLS_CA_PATH'] || path.join(defaultCertDir, 'ca.crt')

    return {
      apiBase,
      wsUrl,
      deviceId: process.env['HEXMON_DEVICE_ID'] || '',
      mtls: {
        enabled: process.env['HEXMON_MTLS_ENABLED'] === 'true',
        certPath: defaultCertPath,
        keyPath: defaultKeyPath,
        caPath: defaultCaPath,
        autoRenew: process.env['HEXMON_MTLS_AUTO_RENEW'] !== 'false',
        renewBeforeDays: parseInt(process.env['HEXMON_MTLS_RENEW_BEFORE_DAYS'] || '30', 10),
      },
      cache: {
        path: defaultCachePath,
        maxBytes: parseInt(process.env['HEXMON_CACHE_MAX_BYTES'] || String(10 * 1024 * 1024 * 1024), 10),
        prefetchConcurrency: parseInt(process.env['HEXMON_CACHE_PREFETCH_CONCURRENCY'] || '3', 10),
        bandwidthBudgetMbps: parseInt(process.env['HEXMON_CACHE_BANDWIDTH_BUDGET_MBPS'] || '50', 10),
      },
      intervals: {
        heartbeatMs: parseInt(process.env['HEXMON_INTERVAL_HEARTBEAT_MS'] || '30000', 10),
        commandPollMs: parseInt(process.env['HEXMON_INTERVAL_COMMAND_POLL_MS'] || '30000', 10),
        schedulePollMs: parseInt(process.env['HEXMON_INTERVAL_SCHEDULE_POLL_MS'] || '300000', 10),
        defaultMediaPollMs: parseInt(process.env['HEXMON_INTERVAL_DEFAULT_MEDIA_POLL_MS'] || '300000', 10),
        healthCheckMs: parseInt(process.env['HEXMON_INTERVAL_HEALTH_CHECK_MS'] || '60000', 10),
        screenshotMs: parseInt(process.env['HEXMON_INTERVAL_SCREENSHOT_MS'] || '300000', 10),
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
  }

  private allowLocalhostFallback(): boolean {
    return process.env['SIGNAGE_ALLOW_LOCALHOST'] === 'true' || process.env['NODE_ENV'] === 'development'
  }

  private buildDefaultApiBase(): string {
    const envApiBase = process.env['SIGNAGE_API_BASE_URL'] || process.env['API_BASE_URL']
    const normalizedEnv = this.normalizeUrl(envApiBase)
    if (normalizedEnv) return normalizedEnv
    return this.allowLocalhostFallback() ? 'http://localhost:3000' : 'http://192.168.0.4:3000'
  }

  private buildDefaultWsUrl(apiBase: string): string {
    const derived = this.deriveWsUrl(apiBase)
    if (derived) return derived
    return this.allowLocalhostFallback() ? 'ws://localhost:3000/ws' : 'ws://192.168.0.4:3000/ws'
  }

  private loadConfig(): AppConfig {
    const fileConfig = this.readConfigFromDisk()
    const merged = this.normalizeConfig(this.mergeConfig(this.defaults, fileConfig || {}))

    if (!fileConfig) {
      this.config = merged
      this.saveConfig()
      return merged
    }

    this.config = merged
    return merged
  }

  private readConfigFromDisk(): Partial<AppConfig> | null {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8')
        return JSON.parse(content) as Partial<AppConfig>
      }
    } catch (error) {
      console.error('Failed to load config file, falling back to defaults:', error)
    }
    return null
  }

  private mergeConfig(defaults: AppConfig, overrides: Partial<AppConfig>): AppConfig {
    return {
      apiBase: overrides.apiBase ?? defaults.apiBase,
      wsUrl: overrides.wsUrl ?? defaults.wsUrl,
      deviceId: overrides.deviceId ?? defaults.deviceId,
      mtls: { ...defaults.mtls, ...overrides.mtls },
      cache: { ...defaults.cache, ...overrides.cache },
      intervals: { ...defaults.intervals, ...overrides.intervals },
      log: { ...defaults.log, ...overrides.log },
      power: { ...defaults.power, ...overrides.power },
      security: { ...defaults.security, ...overrides.security },
    }
  }

  private normalizeConfig(config: AppConfig): AppConfig {
    const apiBase = this.normalizeUrl(config.apiBase) || this.buildDefaultApiBase()
    const wsUrl = this.normalizeUrl(config.wsUrl) || this.buildDefaultWsUrl(apiBase)

    return {
      ...config,
      apiBase,
      wsUrl,
    }
  }

  private deriveWsUrl(apiBase: string): string | null {
    try {
      const url = new URL(apiBase)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.pathname = '/ws'
      url.search = ''
      url.hash = ''
      return url.toString().replace(/\/$/, '')
    } catch {
      return null
    }
  }

  private normalizeUrl(value?: string | null): string {
    if (!value) return ''
    return value.replace(/\/+$/, '')
  }

  private cloneConfig(config: AppConfig): AppConfig {
    return {
      ...config,
      mtls: { ...config.mtls },
      cache: { ...config.cache },
      intervals: { ...config.intervals },
      log: { ...config.log },
      power: { ...config.power },
      security: { ...config.security, allowedDomains: [...config.security.allowedDomains] },
    }
  }

  public getConfig(): AppConfig {
    return this.cloneConfig(this.config)
  }

  public updateConfig(updates: Partial<AppConfig>): AppConfig {
    const normalizedUpdates = { ...updates }
    if (updates?.apiBase && updates.wsUrl === undefined) {
      normalizedUpdates.wsUrl = this.buildDefaultWsUrl(this.normalizeUrl(updates.apiBase))
    }

    this.config = this.normalizeConfig(this.mergeConfig(this.config, normalizedUpdates))
    this.saveConfig()
    this.emitter.emit('change', this.getConfig())
    return this.getConfig()
  }

  public saveConfig(): void {
    try {
      const dir = path.dirname(this.configPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
      }

      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), { mode: 0o600 })
    } catch (error) {
      console.error('Failed to save config:', error)
      throw error
    }
  }

  public get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key]
  }

  public set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.updateConfig({ [key]: value } as Partial<AppConfig>)
  }

  public onChange(listener: (config: AppConfig) => void): () => void {
    this.emitter.on('change', listener)
    return () => this.emitter.off('change', listener)
  }

  public getConfigPath(): string {
    return this.configPath
  }

  public validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (!this.config.apiBase) {
      errors.push('apiBase is required')
    }

    if (!this.config.wsUrl) {
      errors.push('wsUrl is required')
    }

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

    if (this.config.cache.maxBytes < 1024 * 1024 * 100) {
      errors.push('cache.maxBytes must be at least 100MB')
    }

    if (this.config.cache.prefetchConcurrency < 1 || this.config.cache.prefetchConcurrency > 10) {
      errors.push('cache.prefetchConcurrency must be between 1 and 10')
    }

    if (this.config.intervals.heartbeatMs < 10000) {
      errors.push('intervals.heartbeatMs must be at least 10 seconds')
    }
    if (this.config.intervals.commandPollMs < 5000) {
      errors.push('intervals.commandPollMs must be at least 5 seconds')
    }
    if (this.config.intervals.schedulePollMs < 10000) {
      errors.push('intervals.schedulePollMs must be at least 10 seconds')
    }
    if (this.config.intervals.defaultMediaPollMs < 10000) {
      errors.push('intervals.defaultMediaPollMs must be at least 10 seconds')
    }
    if (this.config.intervals.screenshotMs < 10000) {
      errors.push('intervals.screenshotMs must be at least 10 seconds')
    }

    if (this.config.mtls.enabled) {
      const paths = [this.config.mtls.certPath, this.config.mtls.keyPath, this.config.mtls.caPath]
      for (const p of paths) {
        if (!p) {
          errors.push(`mTLS path is required when mTLS is enabled: ${p}`)
        }
      }
    }

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
