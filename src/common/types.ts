/**
 * Common types and interfaces for HexmonSignage Player
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface AppConfig {
  apiBase: string
  wsUrl: string
  deviceId: string
  mtls: MTLSConfig
  cache: CacheConfig
  intervals: IntervalsConfig
  log: LogConfig
  power: PowerConfig
  security: SecurityConfig
}

export interface MTLSConfig {
  enabled: boolean
  certPath: string
  keyPath: string
  caPath: string
  autoRenew: boolean
  renewBeforeDays: number
}

export interface CacheConfig {
  path: string
  maxBytes: number
  prefetchConcurrency: number
  bandwidthBudgetMbps: number
}

export interface IntervalsConfig {
  heartbeatMs: number
  commandPollMs: number
  schedulePollMs: number
  healthCheckMs: number
}

export interface LogConfig {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  shipPolicy: 'realtime' | 'batch' | 'manual'
  rotationSizeMb: number
  rotationIntervalHours: number
  compressionEnabled: boolean
}

export interface PowerConfig {
  dpmsEnabled: boolean
  preventBlanking: boolean
  scheduleEnabled: boolean
  onTime?: string // HH:MM format
  offTime?: string // HH:MM format
}

export interface SecurityConfig {
  csp: string
  allowedDomains: string[]
  disableEval: boolean
  contextIsolation: boolean
  nodeIntegration: boolean
  sandbox: boolean
}

// ============================================================================
// Media & Content Types
// ============================================================================

export type MediaType = 'image' | 'video' | 'pdf' | 'url' | 'office'
export type FitMode = 'contain' | 'cover' | 'stretch'

export interface TimelineItem {
  id: string
  type: MediaType
  objectKey?: string
  url?: string
  displayMs: number
  fit: FitMode
  muted: boolean
  sha256?: string
  meta?: Record<string, unknown>
  transitionDurationMs: number
}

export interface ScheduleSnapshot {
  id: string
  version: number
  publishedAt: string
  items: TimelineItem[]
  validFrom?: string
  validUntil?: string
}

export interface EmergencyOverride {
  id: string
  active: boolean
  priority: number
  content: TimelineItem
  createdAt: string
  clearedAt?: string
}

// ============================================================================
// Cache Types
// ============================================================================

export interface CacheEntry {
  objectKey: string
  sha256: string
  size: number
  etag?: string
  lastUsedAt: number
  localPath: string
  status: 'pending' | 'downloading' | 'ready' | 'quarantined' | 'error'
  downloadProgress?: number
  errorMessage?: string
}

export interface CacheStats {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  entryCount: number
  quarantinedCount: number
}

// ============================================================================
// Device & Telemetry Types
// ============================================================================

export interface DeviceInfo {
  deviceId: string
  hostname: string
  platform: string
  arch: string
  appVersion: string
  electronVersion: string
  nodeVersion: string
}

export interface SystemStats {
  cpuUsage: number
  memoryUsage: number
  memoryTotal: number
  diskUsage: number
  diskTotal: number
  temperature?: number
  uptime: number
  networkInterfaces: NetworkInterface[]
}

export interface NetworkInterface {
  name: string
  address: string
  netmask: string
  family: 'IPv4' | 'IPv6'
  internal: boolean
}

export interface HeartbeatPayload {
  device_id: string
  status: 'ONLINE' | 'OFFLINE' | 'ERROR'
  uptime: number
  memory_usage: number
  cpu_usage: number
  temperature?: number
  current_schedule_id?: string
  current_media_id?: string
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  appVersion: string
  uptime: number
  lastScheduleSync?: string
  cacheUsage: CacheStats
  lastErrors: string[]
  systemStats: SystemStats
  timestamp: string
}

// ============================================================================
// Proof-of-Play Types
// ============================================================================

export interface ProofOfPlayEvent {
  device_id: string
  schedule_id: string
  media_id: string
  start_time: string
  end_time: string
  duration: number
  completed: boolean
}

// ============================================================================
// Device Commands Types
// ============================================================================

export type CommandType = 'REBOOT' | 'REFRESH_SCHEDULE' | 'SCREENSHOT' | 'TEST_PATTERN' | 'CLEAR_CACHE' | 'PING'

export interface DeviceCommand {
  id: string
  type: CommandType
  payload?: Record<string, unknown>
  createdAt: string
  expiresAt?: string
}

export interface CommandAcknowledgment {
  commandId: string
  result: 'success' | 'error'
  message?: string
  data?: Record<string, unknown>
  timestamp: string
}

// Command types for command processor
export interface Command {
  id: string
  type: CommandType
  params?: Record<string, unknown>
  createdAt?: string
  expiresAt?: string
}

export interface CommandResult {
  success: boolean
  message?: string
  error?: string
  data?: Record<string, unknown>
  timestamp: string
}

// ============================================================================
// Diagnostics Types
// ============================================================================

export interface DiagnosticsInfo {
  deviceId: string
  ipAddress: string
  ipAddresses?: string[]
  hostname?: string
  wsState: 'connected' | 'disconnected' | 'connecting'
  lastSync: string
  cacheUsage: number
  commandQueueSize: number
  screenMode: string
  uptime: number
  version: string
  dnsResolution?: boolean
  apiReachable?: boolean
  latency?: number
}

// ============================================================================
// Pairing Types
// ============================================================================

export interface PairingRequest {
  pairing_code: string
  csr: string
  device_info?: DeviceInfo
}

export interface PairingResponse {
  device_id: string
  success?: boolean
  certificate?: string
  ca_certificate?: string
  api_base?: string
  ws_url?: string
}

// ============================================================================
// WebSocket Types
// ============================================================================

export type WSMessageType = 'emergency' | 'command' | 'schedule_update' | 'ping' | 'pong'

export interface WSMessage {
  type: WSMessageType
  payload: unknown
  timestamp: string
}

// ============================================================================
// Display Types
// ============================================================================

export interface DisplayInfo {
  id: string
  name: string
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
  workArea: {
    x: number
    y: number
    width: number
    height: number
  }
  scaleFactor: number
  rotation: number
  internal: boolean
}

// ============================================================================
// Error Types
// ============================================================================

export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class NetworkError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'NETWORK_ERROR', details)
    this.name = 'NetworkError'
  }
}

export class CacheError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CACHE_ERROR', details)
    this.name = 'CacheError'
  }
}

export class PlaybackError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PLAYBACK_ERROR', details)
    this.name = 'PlaybackError'
  }
}
