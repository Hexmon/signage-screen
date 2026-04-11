/**
 * Configuration management persisted to a user-writable JSON file.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as net from 'net'
import { EventEmitter } from 'events'
import type { AppConfig, RuntimeMode } from './types'
import { importLegacyLinuxRuntimeState, resolveRuntimePaths, type RuntimePaths } from './platform-paths'

const RUNTIME_MODES: RuntimeMode[] = ['dev', 'qa', 'production']
const LEGACY_COMMAND_POLL_MS = 30000
const LIVE_COMMAND_POLL_MS = 5000
const LEGACY_PLAYER_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"

function buildDefaultPlayerCsp(): string {
  return [
    "default-src 'self' data: blob: file: http: https:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: file: http: https:",
    "media-src 'self' data: blob: file: http: https:",
    "connect-src 'self' data: blob: http: https: ws: wss:",
    "frame-src 'self' data: blob: file: http: https:",
    "worker-src 'self' blob:",
    "font-src 'self' data: http: https:",
    "object-src 'none'",
  ].join('; ')
}

function buildDefaultObservabilityBindAddress(allowRemoteAccess: boolean): string {
  return allowRemoteAccess ? '0.0.0.0' : '127.0.0.1'
}

function isLoopbackAddress(value: string): boolean {
  if (!value) {
    return false
  }

  const normalized = value.trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

export class ConfigManager {
  private config: AppConfig
  private readonly configPath: string
  private readonly defaults: AppConfig
  private readonly runtimePaths: RuntimePaths
  private readonly emitter = new EventEmitter()

  constructor(configPath?: string) {
    this.runtimePaths = resolveRuntimePaths()
    if (!configPath) {
      importLegacyLinuxRuntimeState(this.runtimePaths)
    }
    this.configPath = configPath || this.getDefaultConfigPath()
    this.defaults = this.buildDefaultConfig()
    this.config = this.loadConfig()
  }

  private getDefaultConfigPath(): string {
    return this.runtimePaths.configPath
  }

  private buildDefaultConfig(): AppConfig {
    const runtimeMode = this.buildDefaultRuntimeMode()
    const apiBase = this.buildDefaultApiBase(runtimeMode)
    const wsUrl = this.buildDefaultWsUrl(apiBase, runtimeMode)

    const defaultCachePath = process.env['HEXMON_CACHE_PATH'] || this.runtimePaths.cachePath
    const defaultCertDir = process.env['HEXMON_MTLS_CERT_DIR'] || this.runtimePaths.certDir

    const defaultCertPath = process.env['HEXMON_MTLS_CERT_PATH'] || path.join(defaultCertDir, 'client.crt')
    const defaultKeyPath = process.env['HEXMON_MTLS_KEY_PATH'] || path.join(defaultCertDir, 'client.key')
    const defaultCaPath = process.env['HEXMON_MTLS_CA_PATH'] || path.join(defaultCertDir, 'ca.crt')

    return {
      apiBase,
      wsUrl,
      deviceId: process.env['HEXMON_DEVICE_ID'] || '',
      runtime: {
        mode: runtimeMode,
      },
      mtls: {
        enabled: process.env['HEXMON_MTLS_ENABLED'] === 'true',
        certPath: defaultCertPath,
        keyPath: defaultKeyPath,
        caPath: defaultCaPath,
        strictCertificateValidation: process.env['HEXMON_MTLS_STRICT_CERTIFICATE_VALIDATION'] !== 'false',
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
        commandPollMs: parseInt(process.env['HEXMON_INTERVAL_COMMAND_POLL_MS'] || '5000', 10),
        schedulePollMs: parseInt(process.env['HEXMON_INTERVAL_SCHEDULE_POLL_MS'] || '300000', 10),
        defaultMediaPollMs: parseInt(process.env['HEXMON_INTERVAL_DEFAULT_MEDIA_POLL_MS'] || '300000', 10),
        healthCheckMs: parseInt(process.env['HEXMON_INTERVAL_HEALTH_CHECK_MS'] || '60000', 10),
        screenshotMs: parseInt(process.env['HEXMON_INTERVAL_SCREENSHOT_MS'] || '30000', 10),
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
        csp: process.env['HEXMON_SECURITY_CSP'] || buildDefaultPlayerCsp(),
        allowedDomains: process.env['HEXMON_SECURITY_ALLOWED_DOMAINS']?.split(',') || [],
        disableEval: process.env['HEXMON_SECURITY_DISABLE_EVAL'] !== 'false',
        contextIsolation: process.env['HEXMON_SECURITY_CONTEXT_ISOLATION'] !== 'false',
        nodeIntegration: process.env['HEXMON_SECURITY_NODE_INTEGRATION'] === 'true',
        sandbox: process.env['HEXMON_SECURITY_SANDBOX'] !== 'false',
      },
      observability: {
        enabled: process.env['HEXMON_OBSERVABILITY_ENABLED'] !== 'false',
        metricsEnabled: process.env['HEXMON_OBSERVABILITY_METRICS_ENABLED'] !== 'false',
        bindAddress: process.env['HEXMON_OBSERVABILITY_BIND_ADDRESS'] || buildDefaultObservabilityBindAddress(false),
        port: parseInt(process.env['HEXMON_OBSERVABILITY_PORT'] || '3300', 10),
        allowRemoteAccess: process.env['HEXMON_OBSERVABILITY_ALLOW_REMOTE_ACCESS'] === 'true',
      },
    }
  }

  public getRuntimePaths(): RuntimePaths {
    return {
      ...this.runtimePaths,
      legacyLinux: { ...this.runtimePaths.legacyLinux },
    }
  }

  private buildDefaultRuntimeMode(): RuntimeMode {
    const requestedMode = (process.env['HEXMON_RUNTIME_MODE'] || '').trim().toLowerCase()
    if (this.isRuntimeMode(requestedMode)) {
      return requestedMode
    }

    return process.env['NODE_ENV'] === 'development' ? 'dev' : 'production'
  }

  private isRuntimeMode(value: string): value is RuntimeMode {
    return RUNTIME_MODES.includes(value as RuntimeMode)
  }

  private allowLocalhostFallback(runtimeMode: RuntimeMode): boolean {
    return (
      process.env['SIGNAGE_ALLOW_LOCALHOST'] === 'true' ||
      process.env['NODE_ENV'] === 'development' ||
      runtimeMode === 'dev'
    )
  }

  private buildDefaultApiBase(runtimeMode: RuntimeMode): string {
    const envApiBase =
      process.env['SIGNAGE_API_BASE_URL'] || process.env['HEXMON_API_BASE'] || process.env['API_BASE_URL']
    const normalizedEnv = this.normalizeUrl(envApiBase)
    if (normalizedEnv) return normalizedEnv
    return this.allowLocalhostFallback(runtimeMode) ? 'http://localhost:3000' : ''
  }

  private buildDefaultWsUrl(apiBase: string, runtimeMode: RuntimeMode): string {
    const envWsUrl = process.env['SIGNAGE_WS_URL'] || process.env['HEXMON_WS_URL'] || process.env['WS_URL']
    const normalizedEnv = this.normalizeUrl(envWsUrl)
    if (normalizedEnv) return normalizedEnv

    const derived = this.deriveWsUrl(apiBase)
    if (derived) return derived
    return this.allowLocalhostFallback(runtimeMode) ? 'ws://localhost:3000/ws' : ''
  }

  private loadConfig(): AppConfig {
    const fileConfig = this.readConfigFromDisk()
    const merged = this.mergeConfig(this.defaults, fileConfig || {})
    const normalized = this.normalizeConfig(merged)

    if (!fileConfig) {
      this.config = normalized
      this.saveConfig()
      return normalized
    }

    this.config = normalized
    if (
      merged.intervals.commandPollMs !== normalized.intervals.commandPollMs ||
      merged.security.csp !== normalized.security.csp
    ) {
      this.saveConfig()
    }
    return normalized
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
      runtime: { ...defaults.runtime, ...overrides.runtime },
      mtls: { ...defaults.mtls, ...overrides.mtls },
      cache: { ...defaults.cache, ...overrides.cache },
      intervals: { ...defaults.intervals, ...overrides.intervals },
      log: { ...defaults.log, ...overrides.log },
      power: { ...defaults.power, ...overrides.power },
      security: { ...defaults.security, ...overrides.security },
      observability: { ...defaults.observability, ...overrides.observability },
    }
  }

  private normalizeConfig(config: AppConfig): AppConfig {
    const runtimeMode = this.getRuntimeModeOverride() || config.runtime.mode
    const apiBase = this.normalizeUrl(config.apiBase) || this.buildDefaultApiBase(runtimeMode)
    const wsUrl = this.normalizeUrl(config.wsUrl) || this.buildDefaultWsUrl(apiBase, runtimeMode)
    const commandPollMs =
      config.intervals.commandPollMs === LEGACY_COMMAND_POLL_MS ? LIVE_COMMAND_POLL_MS : config.intervals.commandPollMs
    const normalizedCsp =
      !config.security.csp || config.security.csp.trim() === '' || config.security.csp === LEGACY_PLAYER_CSP
        ? buildDefaultPlayerCsp()
        : config.security.csp
    const allowRemoteAccess = config.observability.allowRemoteAccess === true
    const requestedBindAddress = config.observability.bindAddress?.trim()
    const bindAddress = allowRemoteAccess
      ? requestedBindAddress || buildDefaultObservabilityBindAddress(true)
      : '127.0.0.1'
    const port =
      Number.isFinite(config.observability.port) && config.observability.port > 0
        ? Math.round(config.observability.port)
        : 3300

    return {
      ...config,
      apiBase,
      wsUrl,
      runtime: {
        ...config.runtime,
        mode: runtimeMode,
      },
      intervals: {
        ...config.intervals,
        commandPollMs,
      },
      security: {
        ...config.security,
        csp: normalizedCsp,
      },
      observability: {
        ...config.observability,
        allowRemoteAccess,
        bindAddress,
        port,
      },
    }
  }

  private getRuntimeModeOverride(): RuntimeMode | undefined {
    const requestedMode = (process.env['HEXMON_RUNTIME_MODE'] || '').trim().toLowerCase()
    if (this.isRuntimeMode(requestedMode)) {
      return requestedMode
    }

    return undefined
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
      runtime: { ...config.runtime },
      mtls: { ...config.mtls },
      cache: { ...config.cache },
      intervals: { ...config.intervals },
      log: { ...config.log },
      power: { ...config.power },
      security: { ...config.security, allowedDomains: [...config.security.allowedDomains] },
      observability: { ...config.observability },
    }
  }

  public getConfig(): AppConfig {
    return this.cloneConfig(this.config)
  }

  public updateConfig(updates: Partial<AppConfig>): AppConfig {
    const normalizedUpdates = { ...updates }
    if (updates?.apiBase && updates.wsUrl === undefined) {
      const runtimeMode = updates.runtime?.mode || this.getRuntimeModeOverride() || this.config.runtime.mode
      normalizedUpdates.wsUrl = this.buildDefaultWsUrl(this.normalizeUrl(updates.apiBase), runtimeMode)
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
    const runtimeMode = this.config.runtime.mode
    const requireExplicitBackend = runtimeMode === 'qa' || runtimeMode === 'production'

    if (!this.config.apiBase) {
      errors.push(
        requireExplicitBackend
          ? 'apiBase is required for qa/production. Configure the backend IP, for example http://10.20.0.20:3000'
          : 'apiBase is required'
      )
    }

    if (!this.config.wsUrl) {
      errors.push(
        requireExplicitBackend
          ? 'wsUrl is required for qa/production. Configure the backend websocket URL, for example ws://10.20.0.20:3000/ws'
          : 'wsUrl is required'
      )
    }

    if (this.config.apiBase) {
      try {
        new URL(this.config.apiBase)
      } catch {
        errors.push('apiBase must be a valid URL')
      }
    }

    if (this.config.wsUrl) {
      try {
        new URL(this.config.wsUrl)
      } catch {
        errors.push('wsUrl must be a valid URL')
      }
    }

    if (!this.isRuntimeMode(this.config.runtime.mode)) {
      errors.push(`runtime.mode must be one of: ${RUNTIME_MODES.join(', ')}`)
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

    if (
      !Number.isInteger(this.config.observability.port) ||
      this.config.observability.port < 1 ||
      this.config.observability.port > 65535
    ) {
      errors.push('observability.port must be between 1 and 65535')
    }

    const bindAddress = this.config.observability.bindAddress.trim()
    if (!bindAddress) {
      errors.push('observability.bindAddress is required')
    } else if (!this.config.observability.allowRemoteAccess && !isLoopbackAddress(bindAddress)) {
      errors.push('observability.bindAddress must remain loopback unless observability.allowRemoteAccess is true')
    } else if (bindAddress !== 'localhost' && net.isIP(bindAddress) === 0 && !/^[a-z0-9.-]+$/i.test(bindAddress)) {
      errors.push('observability.bindAddress must be a valid IP address or hostname')
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
