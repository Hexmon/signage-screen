/**
 * Common types and interfaces for HexmonSignage Player
 */

// ============================================================================
// Configuration Types
// ============================================================================

export type RuntimeMode = 'dev' | 'qa' | 'production'

export interface AppConfig {
  apiBase: string
  wsUrl: string
  deviceId: string
  runtime: RuntimeConfig
  mtls: MTLSConfig
  cache: CacheConfig
  intervals: IntervalsConfig
  log: LogConfig
  power: PowerConfig
  security: SecurityConfig
}

export interface RuntimeConfig {
  mode: RuntimeMode
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
  defaultMediaPollMs: number
  healthCheckMs: number
  screenshotMs: number
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

export type MediaType = 'image' | 'video' | 'pdf' | 'url' | 'office' | 'scene'
export type FitMode = 'contain' | 'cover' | 'stretch'

export interface LayoutSceneSlotBounds {
  x: number | string
  y: number | string
  w: number | string
  h: number | string
  zIndex?: number
}

export interface LayoutSceneSlot {
  id: string
  bounds: LayoutSceneSlotBounds
  items: TimelineItem[]
}

export interface LayoutScene {
  layoutId?: string
  layoutName?: string
  aspectRatio?: string
  startsAt?: string
  endsAt?: string
  slots: LayoutSceneSlot[]
}

// CMS default media types
export type DefaultMediaType = 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'WEBPAGE'

export interface DefaultMediaItem {
  id: string
  name: string
  type: DefaultMediaType
  content_type?: string
  source_content_type?: string
  media_url?: string
  source_url?: string
  fallback_media_url?: string
  local_path?: string
  local_url?: string
}

export interface DefaultMediaResponse {
  source?: 'SCREEN' | 'GROUP' | 'ASPECT_RATIO' | 'GLOBAL' | 'NONE'
  aspect_ratio?: string | null
  media_id: string | null
  media: DefaultMediaItem | null
}

export interface ScreenshotPolicyResponse {
  enabled: boolean
  interval_seconds: number | null
}

// Player lifecycle state machine
export type PlayerState =
  | 'BOOT'
  | 'BOOTSTRAP_AUTH'
  | 'SOFT_RECOVERY'
  | 'RECOVERY_REQUIRED'
  | 'HARD_RECOVERY'
  | 'PAIRING_PENDING'
  | 'PAIRING_CONFIRMED'
  | 'PAIRING_COMPLETING'
  | 'PAIRED_RUNTIME'

export type PlaybackMode = 'normal' | 'emergency' | 'default' | 'offline' | 'empty'

export interface PlayerStatus {
  state: PlayerState
  mode: PlaybackMode
  online: boolean
  deviceId?: string
  pairingCode?: string
  pairingExpiresAt?: string
  recoveryReason?: string
  hardRecoveryDeadlineAt?: string
  backendAvailable?: boolean
  awaitingManualRecovery?: boolean
  scheduleId?: string
  currentMediaId?: string
  lastSnapshotAt?: string
  lastHeartbeatAt?: string
  error?: string
}

export interface TimelineItem {
  id: string
  type: MediaType
  // Preferred identifiers
  mediaId?: string
  remoteUrl?: string
  localPath?: string
  localUrl?: string
  // Legacy fields
  objectKey?: string
  url?: string
  displayMs: number
  fit: FitMode
  muted: boolean
  loop: boolean
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

// Snapshot payload (device API)
export interface SnapshotScheduleItem {
  id?: string
  presentation_id?: string
  start_at?: string
  end_at?: string
  priority?: number
  screen_ids?: string[]
  screen_group_ids?: string[]
  media_id?: string
  mediaId?: string
  type?: MediaType
  media_type?: MediaType
  display_ms?: number
  displayMs?: number
  duration_ms?: number
  durationMs?: number
  fit?: FitMode
  fit_mode?: FitMode
  muted?: boolean
  transition_ms?: number
  transitionDurationMs?: number
  meta?: Record<string, unknown>
  media_url?: string
  url?: string
  sha256?: string
  presentation?: SnapshotPresentation | null
}

export interface SnapshotSchedule {
  id?: string
  version?: number
  timezone?: string | null
  start_at?: string
  end_at?: string
  items?: SnapshotScheduleItem[]
}

export interface SnapshotLayout {
  id?: string
  name?: string
  description?: string | null
  aspect_ratio?: string
  spec?: Record<string, unknown> | { slots?: unknown[] }
}

export interface SnapshotPresentationMedia {
  id?: string
  name?: string
  type?: string
  status?: string
  content_type?: string
  source_content_type?: string
  source_url?: string | null
  fallback_url?: string | null
  url?: string | null
  source_bucket?: string
  source_object_key?: string
  ready_object_id?: string | null
  thumbnail_object_id?: string | null
}

export interface SnapshotPresentationItem {
  id?: string
  media_id?: string
  order?: number
  duration_seconds?: number
  media?: SnapshotPresentationMedia | null
}

export interface SnapshotPresentationSlotItem {
  id?: string
  slot_id?: string
  media_id?: string
  order?: number
  duration_seconds?: number
  fit_mode?: FitMode | string
  audio_enabled?: boolean
  loop_enabled?: boolean
  media?: SnapshotPresentationMedia | null
}

export interface SnapshotPresentation {
  id?: string
  name?: string
  description?: string | null
  layout?: SnapshotLayout | null
  items?: SnapshotPresentationItem[]
  slots?: SnapshotPresentationSlotItem[]
}

export interface SnapshotMediaUrlMap {
  [mediaId: string]: string
}

export interface SnapshotMediaEntry {
  media_id?: string
  mediaId?: string
  url?: string
  media_url?: string
  source_url?: string | null
  fallback_url?: string | null
  type?: MediaType
  media_type?: MediaType
  content_type?: string
  source_content_type?: string
  sha256?: string
  size?: number
}

export interface DeviceSnapshot {
  id?: string
  snapshot_id?: string
  schedule?: SnapshotSchedule
  items?: SnapshotScheduleItem[]
  media_urls?: SnapshotMediaUrlMap
  mediaUrls?: SnapshotMediaUrlMap
  media?: SnapshotMediaEntry[]
  emergency?: {
    active?: boolean
    expires_at?: string | null
    media_id?: string
    mediaId?: string
    media_url?: string
    url?: string
    source_url?: string | null
    fallback_url?: string | null
    type?: MediaType
    media_type?: MediaType
    content_type?: string
    source_content_type?: string
    display_ms?: number
    displayMs?: number
    fit?: FitMode
    muted?: boolean
    transition_ms?: number
  }
  default_media?: {
    media_id?: string
    mediaId?: string
    media_url?: string
    url?: string
    source_url?: string | null
    fallback_url?: string | null
    type?: MediaType
    media_type?: MediaType
    content_type?: string
    source_content_type?: string
    display_ms?: number
    displayMs?: number
    fit?: FitMode
    muted?: boolean
    transition_ms?: number
  }
  generated_at?: string
  fetched_at?: string
}

// ============================================================================
// Cache Types
// ============================================================================

export interface CacheEntry {
  mediaId: string
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
  cpuCores: number
  cpuLoad1m: number
  cpuLoad5m: number
  cpuLoad15m: number
  memoryUsage: number
  memoryTotal: number
  memoryFree: number
  diskUsage: number
  diskTotal: number
  diskFree: number
  temperature?: number
  uptime: number
  networkInterfaces: NetworkInterface[]
  primaryNetworkInterface?: string
  primaryNetworkAddress?: string
  displayCount: number
  displays: DisplayTelemetry[]
  hostname: string
  osVersion: string
  batteryPercent?: number
  isCharging?: boolean
  powerSource?: PowerSource
}

export interface NetworkInterface {
  name: string
  address: string
  netmask: string
  family: 'IPv4' | 'IPv6'
  internal: boolean
}

export interface DisplayTelemetry {
  id?: string
  width: number
  height: number
  refresh_rate_hz?: number
  orientation?: 'portrait' | 'landscape'
  connected?: boolean
  model?: string
}

export type PowerSource = 'AC' | 'BATTERY' | 'USB' | 'UNKNOWN'

export interface HeartbeatPayload {
  device_id: string
  status: 'ONLINE' | 'OFFLINE' | 'ERROR'
  uptime: number
  memory_usage: number
  cpu_usage: number
  temperature?: number
  current_schedule_id?: string
  current_media_id?: string
  memory_total_mb?: number
  memory_used_mb?: number
  memory_free_mb?: number
  cpu_cores?: number
  cpu_load_1m?: number
  cpu_load_5m?: number
  cpu_load_15m?: number
  cpu_temp_c?: number
  disk_total_gb?: number
  disk_used_gb?: number
  disk_free_gb?: number
  disk_usage_percent?: number
  network_ip?: string
  network_interface?: string
  display_count?: number
  displays?: DisplayTelemetry[]
  os_version?: string
  hostname?: string
  player_uptime_seconds?: number
  battery_percent?: number
  is_charging?: boolean
  power_source?: PowerSource
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

export type CommandType =
  | 'REBOOT'
  | 'REFRESH'
  | 'REFRESH_SCHEDULE'
  | 'SCREENSHOT'
  | 'TAKE_SCREENSHOT'
  | 'SET_SCREENSHOT_INTERVAL'
  | 'TEST_PATTERN'
  | 'CLEAR_CACHE'
  | 'PING'

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
  playerState?: PlayerState
  playbackMode?: PlaybackMode
}

// ============================================================================
// Pairing Types
// ============================================================================

export interface PairingRequest {
  pairing_code: string
  csr: string
  device_info?: DeviceInfo
}

export type ActivePairingMode = 'PAIRING' | 'RECOVERY'

export interface ActivePairingStatus {
  id?: string
  pairing_code?: string
  expires_at?: string
  expires_in?: number
  confirmed: boolean
  mode: ActivePairingMode
}

export interface PairingStatusResponse {
  device_id: string
  paired?: boolean
  confirmed?: boolean
  screen: {
    id: string
    status: string
  } | null
  active_pairing?: ActivePairingStatus | null
}

export type PairingOrientation = 'landscape' | 'portrait'

export interface PairingCodeRequest {
  device_label?: string
  width?: number
  height?: number
  aspect_ratio?: string
  orientation?: PairingOrientation
  model?: string
  codecs?: string[]
  device_info?: {
    os?: string
    [key: string]: unknown
  }
}

export interface PairingCodeResponse {
  id: string
  device_id: string
  pairing_code: string
  expires_at: string
  expires_in: number
  connected: boolean
  observed_ip?: string
  specs?: Record<string, unknown>
}

export interface PairingResponse {
  device_id: string
  success?: boolean
  certificate?: string
  ca_certificate?: string
  fingerprint?: string
  expires_at?: string
  api_base?: string
  ws_url?: string
}

export type RecoveryKind = 'AUTH_INVALID' | 'DEVICE_NOT_REGISTERED' | 'PARTIAL_IDENTITY' | 'PAIRING_FAILED' | 'UNKNOWN'

export interface RecentCommandRecord {
  id: string
  firstSeenAt: string
  lastSeenAt: string
  source: 'heartbeat' | 'poll'
  acknowledgedAt?: string
}

export interface DeviceStateRecord {
  lifecycleState?: PlayerState
  deviceId?: string
  pairingCode?: string
  pairingExpiresAt?: string
  activePairingMode?: ActivePairingMode
  fingerprint?: string
  lastSuccessfulPairingAt?: string
  lastHeartbeatAt?: string
  recoveryReason?: string
  hardRecoveryDeadlineAt?: string
  pairingRequestInDoubtAt?: string
  recentCommands?: RecentCommandRecord[]
}

export type BackendErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'CA_CERT_MISSING'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR'

export interface BackendErrorPayload {
  success?: false
  error?: {
    code?: BackendErrorCode
    message?: string
    details?: unknown
    traceId?: string
  }
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

export class DeviceApiError extends AppError {
  public readonly status?: number
  public readonly traceId?: string
  public readonly transient: boolean
  public readonly detailsPayload?: unknown

  constructor(args: {
    message: string
    code: BackendErrorCode
    status?: number
    traceId?: string
    transient?: boolean
    detailsPayload?: unknown
  }) {
    super(args.message, args.code, { status: args.status, traceId: args.traceId })
    this.name = 'DeviceApiError'
    this.status = args.status
    this.traceId = args.traceId
    this.transient = args.transient ?? false
    this.detailsPayload = args.detailsPayload
  }
}

export function isDeviceApiError(error: unknown): error is DeviceApiError {
  return error instanceof DeviceApiError
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
