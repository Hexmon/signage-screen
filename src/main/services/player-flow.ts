import { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import { DeviceApiError, PairingCodeRequest, PairingCodeResponse, PairingResponse, PairingStatusResponse, PlayerState, PlayerStatus } from '../../common/types'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { ExponentialBackoff } from '../../common/utils'
import { getDeviceStateStore } from './device-state-store'
import { getPairingService } from './pairing-service'
import { getSnapshotManager, PlaybackPlaylist } from './snapshot-manager'
import { getPlaybackEngine } from './playback/playback-engine'
import { getTelemetryService } from './telemetry/telemetry-service'
import { getHeartbeatService } from './telemetry/heartbeat'
import { getCommandProcessor } from './command-processor'
import { getScreenshotService } from './screenshot-service'
import { getDefaultMediaService } from './settings/default-media-service'
import { getLifecycleEvents, RuntimeAuthFailureEvent } from './lifecycle-events'
import { getHttpClient } from './network/http-client'

const logger = getLogger('player-flow')
const PAIRING_POLL_INTERVAL_MS = 5000

function requiresTimelinePlayback(playlist: PlaybackPlaylist): boolean {
  return (playlist.mode === 'normal' || playlist.mode === 'emergency') && playlist.items.length > 0
}

export class PlayerFlow extends EventEmitter {
  private state: PlayerState = 'BOOT'
  private status: PlayerStatus = {
    state: 'BOOT',
    mode: 'empty',
    online: false,
    backendAvailable: false,
  }
  private mainWindow?: BrowserWindow
  private runtimeLoopsStarted = false
  private playbackReady = false
  private snapshotListenerBound = false
  private lifecycleEventsBound = false
  private screenshotInterval?: NodeJS.Timeout
  private pairingPollTimer?: NodeJS.Timeout
  private bootstrapRetryTimer?: NodeJS.Timeout
  private readonly bootstrapBackoff = new ExponentialBackoff(2000, 30000, 10, 0.2)
  private readonly pairingPollBackoff = new ExponentialBackoff(2000, 30000, 10, 0.2)
  private readonly store = getDeviceStateStore()
  private readonly pairingService = getPairingService()
  private readonly lifecycleEvents = getLifecycleEvents()
  private readonly onRuntimeAuthFailure = (event: RuntimeAuthFailureEvent) => {
    void this.handleRuntimeAuthFailure(event)
  }

  constructor() {
    super()
    this.store.onChange(() => {
      this.refreshStatusFromState()
    })
  }

  initialize(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow

    const playbackEngine = getPlaybackEngine()
    playbackEngine.initialize(mainWindow)
    playbackEngine.on('item-playing', (item) => {
      this.updateStatus({
        currentMediaId: item.mediaId || item.id,
      })
    })

    getScreenshotService().initialize(mainWindow)
    getDefaultMediaService().initialize(mainWindow)
    this.bindLifecycleEvents()
    this.bindSnapshotListener()
  }

  async start(): Promise<void> {
    this.bindLifecycleEvents()
    this.bindSnapshotListener()
    await this.transitionState('BOOT', {
      error: 'Starting player...',
    })

    await this.restoreCachedPlayback()

    const persisted = this.store.getState()
    const identity = this.pairingService.getStoredIdentityHealth()
    const trustworthyDeviceId = this.pairingService.hasTrustworthyDeviceId()

    if (identity.health === 'complete' && trustworthyDeviceId) {
      await this.bootstrapAuthenticatedRuntime()
      return
    }

    if (persisted.pairingCode && trustworthyDeviceId && this.isPairingCodeStillValid(persisted.pairingExpiresAt)) {
      await this.transitionState('PAIRING_PENDING', {
        error: 'Waiting for admin approval...',
      })
      this.startPairingStatusPolling()
      return
    }

    if (identity.health === 'partial' && trustworthyDeviceId) {
      await this.enterRecoveryRequired(identity.issues.join('. ') || 'Stored device identity is incomplete')
      return
    }

    await this.enterHardRecovery('No trustworthy persisted device identity is available')
  }

  getState(): PlayerState {
    return this.state
  }

  getStatus(): PlayerStatus {
    return { ...this.status }
  }

  async requestPairingCode(overrides?: Partial<PairingCodeRequest>): Promise<PairingCodeResponse | null> {
    const fallbackState: Extract<PlayerState, 'HARD_RECOVERY' | 'PAIRING_PENDING'> =
      this.state === 'PAIRING_PENDING' || this.state === 'PAIRING_CONFIRMED' || this.state === 'PAIRING_COMPLETING'
        ? 'PAIRING_PENDING'
        : 'HARD_RECOVERY'
    return await this.requestFreshPairingCode(overrides, fallbackState)
  }

  async checkPairingStatus(): Promise<PairingStatusResponse> {
    return await this.pairingService.fetchPairingStatus()
  }

  async completePairing(): Promise<PairingResponse | null> {
    return await this.attemptPairingCompletion()
  }

  async performAction(
    action: 'retry-recovery' | 're-pair' | 'reset-doubtful-pairing' | 'refresh-pairing',
    payload?: Partial<PairingCodeRequest>
  ): Promise<void> {
    switch (action) {
      case 'retry-recovery':
        await this.retryRecovery()
        break
      case 're-pair':
      case 'refresh-pairing':
      case 'reset-doubtful-pairing':
        await this.enterHardRecovery('Fresh pairing requested', payload)
        break
      default:
        break
    }
  }

  async refreshSnapshot(): Promise<void> {
    await getSnapshotManager().refreshSnapshot()
  }

  async stop(): Promise<void> {
    this.stopPairingTimers()
    this.stopBootstrapRetryTimer()
    this.stopRuntimeLoops(false)
    this.unbindLifecycleEvents()
  }

  private bindLifecycleEvents(): void {
    if (this.lifecycleEventsBound) {
      return
    }

    this.lifecycleEvents.onRuntimeAuthFailure(this.onRuntimeAuthFailure)
    this.lifecycleEventsBound = true
  }

  private unbindLifecycleEvents(): void {
    if (!this.lifecycleEventsBound) {
      return
    }

    this.lifecycleEvents.off('runtime-auth-failure', this.onRuntimeAuthFailure)
    this.lifecycleEventsBound = false
  }

  private bindSnapshotListener(): void {
    if (this.snapshotListenerBound) {
      return
    }

    this.snapshotListenerBound = true
    getSnapshotManager().on('playlist-updated', (playlist: PlaybackPlaylist) => {
      this.handlePlaylistUpdate(playlist)
    })
  }

  private async restoreCachedPlayback(): Promise<void> {
    const cachedPlaylist = getSnapshotManager().getCurrentPlaylist()
    if (!cachedPlaylist) {
      return
    }

    this.handlePlaylistUpdate(cachedPlaylist)
  }

  private async bootstrapAuthenticatedRuntime(): Promise<void> {
    this.stopPairingTimers()
    this.stopBootstrapRetryTimer()
    this.bindSnapshotListener()
    await this.restoreCachedPlayback()

    await this.transitionState('BOOTSTRAP_AUTH', {
      error: 'Validating device access...',
      backendAvailable: true,
      awaitingManualRecovery: false,
    })

    try {
      await this.probeAuthenticatedSnapshot()
      await getSnapshotManager().refreshSnapshot()
      await getHeartbeatService().sendImmediate()
      await this.startRuntimeLoops()
      await this.store.update({
        lifecycleState: 'PAIRED_RUNTIME',
        recoveryReason: undefined,
        hardRecoveryDeadlineAt: undefined,
      })
      await this.transitionState('PAIRED_RUNTIME', {
        backendAvailable: true,
        awaitingManualRecovery: false,
        error: undefined,
        recoveryReason: undefined,
      })
      this.bootstrapBackoff.reset()
    } catch (error) {
      await this.handleBootstrapFailure(error)
    }
  }

  private async startRuntimeLoops(): Promise<void> {
    if (this.runtimeLoopsStarted) {
      return
    }

    this.runtimeLoopsStarted = true
    getCommandProcessor().start()
    await getTelemetryService().start()
    getSnapshotManager().start()
    getDefaultMediaService().start()
    this.startScreenshotLoop()
  }

  private stopRuntimeLoops(stopPlayback: boolean): void {
    getCommandProcessor().stop()
    void getTelemetryService().stop()
    getSnapshotManager().stop()
    getDefaultMediaService().stop()
    this.stopScreenshotLoop()
    this.runtimeLoopsStarted = false

    if (stopPlayback) {
      getPlaybackEngine().stop()
      this.playbackReady = false
    }
  }

  private handlePlaylistUpdate(playlist: PlaybackPlaylist): void {
    if (requiresTimelinePlayback(playlist)) {
      if (!this.playbackReady) {
        void getPlaybackEngine().start()
        this.playbackReady = true
      }
    } else if (this.playbackReady) {
      getPlaybackEngine().stop()
      this.playbackReady = false
    }

    this.updateStatus({
      mode: playlist.mode,
      online: playlist.mode !== 'offline' && playlist.mode !== 'empty',
      scheduleId: playlist.scheduleId,
      currentMediaId: requiresTimelinePlayback(playlist) ? this.status.currentMediaId : undefined,
      lastSnapshotAt: playlist.lastSnapshotAt,
      backendAvailable: playlist.mode !== 'offline',
    })
  }

  private startScreenshotLoop(): void {
    this.stopScreenshotLoop()
    const scheduleNext = () => {
      if (!this.runtimeLoopsStarted) {
        return
      }

      const intervalMs = getConfigManager().getConfig().intervals.screenshotMs
      this.screenshotInterval = setTimeout(async () => {
        try {
          if (getScreenshotService().isCaptureEnabled()) {
            await getScreenshotService().captureAndUpload()
          }
        } catch (error) {
          logger.warn({ error }, 'Screenshot upload failed')
        } finally {
          scheduleNext()
        }
      }, intervalMs)
    }

    scheduleNext()
  }

  private stopScreenshotLoop(): void {
    if (this.screenshotInterval) {
      clearInterval(this.screenshotInterval)
      this.screenshotInterval = undefined
    }
  }

  private async probeAuthenticatedSnapshot(): Promise<void> {
    const deviceId = this.pairingService.getDeviceId()
    if (!deviceId || !this.pairingService.hasTrustworthyDeviceId()) {
      throw new Error('Invalid or missing stored device id')
    }

    try {
      const response = await getHttpClient().get(`/api/v1/device/${deviceId}/snapshot?include_urls=true`, {
        retry: false,
      })
      if (response && typeof response === 'object' && (response as Record<string, unknown>)['success'] === false) {
        throw new Error(String((response as { error?: { message?: string } }).error?.message || 'Snapshot request failed'))
      }
    } catch (error) {
      if (error instanceof DeviceApiError && error.code === 'NOT_FOUND' && !error.message.includes('Device not registered')) {
        return
      }
      throw error
    }
  }

  private async handleBootstrapFailure(error: unknown): Promise<void> {
    if (this.pairingService.isDeviceNotRegisteredError(error) || !this.pairingService.hasTrustworthyDeviceId()) {
      await this.enterHardRecovery((error as Error).message || 'Stored device identity is no longer registered')
      return
    }

    if (this.pairingService.isInvalidCredentialError(error)) {
      await this.enterRecoveryRequired((error as Error).message || 'Device credentials are no longer valid')
      return
    }

    if (this.pairingService.isTransientRuntimeError(error)) {
      await this.enterSoftRecovery((error as Error).message || 'Backend is temporarily unavailable')
      return
    }

    await this.enterRecoveryRequired((error as Error).message || 'Unable to validate stored device credentials')
  }

  private async enterSoftRecovery(reason: string): Promise<void> {
    this.stopPairingTimers()
    this.stopRuntimeLoops(false)

    await this.store.update({
      lifecycleState: 'SOFT_RECOVERY',
      recoveryReason: reason,
    })

    await this.transitionState('SOFT_RECOVERY', {
      backendAvailable: false,
      awaitingManualRecovery: false,
      error: reason,
      recoveryReason: reason,
    })

    this.scheduleBootstrapRetry(this.bootstrapBackoff.getDelay())
  }

  private scheduleBootstrapRetry(delayMs: number): void {
    this.stopBootstrapRetryTimer()
    this.bootstrapRetryTimer = setTimeout(() => {
      void this.bootstrapAuthenticatedRuntime()
    }, delayMs)
  }

  private stopBootstrapRetryTimer(): void {
    if (this.bootstrapRetryTimer) {
      clearTimeout(this.bootstrapRetryTimer)
      this.bootstrapRetryTimer = undefined
    }
  }

  private async enterRecoveryRequired(reason: string): Promise<void> {
    this.stopBootstrapRetryTimer()
    this.stopRuntimeLoops(false)

    await this.store.update({
      lifecycleState: 'RECOVERY_REQUIRED',
      recoveryReason: reason,
      pairingCode: undefined,
      pairingExpiresAt: undefined,
      activePairingMode: undefined,
      hardRecoveryDeadlineAt: undefined,
    })

    await this.transitionState('RECOVERY_REQUIRED', {
      backendAvailable: true,
      awaitingManualRecovery: true,
      error: reason,
      recoveryReason: reason,
    })

    this.startPairingStatusPolling()
  }

  private async enterHardRecovery(reason: string, overrides?: Partial<PairingCodeRequest>): Promise<void> {
    this.stopBootstrapRetryTimer()
    this.stopPairingTimers()
    this.stopRuntimeLoops(false)

    await this.store.update({
      lifecycleState: 'HARD_RECOVERY',
      recoveryReason: reason,
      hardRecoveryDeadlineAt: undefined,
    })

    await this.transitionState('HARD_RECOVERY', {
      backendAvailable: true,
      awaitingManualRecovery: false,
      error: reason,
      recoveryReason: reason,
      hardRecoveryDeadlineAt: undefined,
    })

    await this.pairingService.resetStoredIdentity(reason)
    await this.requestFreshPairingCode(overrides, 'HARD_RECOVERY')
  }

  private async requestFreshPairingCode(
    overrides?: Partial<PairingCodeRequest>,
    failureState: Extract<PlayerState, 'HARD_RECOVERY' | 'PAIRING_PENDING'> = 'HARD_RECOVERY'
  ): Promise<PairingCodeResponse | null> {
    this.stopPairingTimers()

    try {
      const response = await this.pairingService.requestPairingCode(overrides)
      this.pairingPollBackoff.reset()
      await this.transitionState('PAIRING_PENDING', {
        error: 'Waiting for admin approval...',
      })
      this.startPairingStatusPolling()
      return response
    } catch (error) {
      logger.error({ error }, 'Pairing request failed')
      await this.pairingService.markPairingRequestInDoubt((error as Error).message)
      await this.transitionState(failureState, {
        error: (error as Error).message,
        recoveryReason: (error as Error).message,
      })
      return null
    }
  }

  private startPairingStatusPolling(): void {
    this.stopPairingTimers()
    this.schedulePairingStatusPoll(0)
  }

  private schedulePairingStatusPoll(delayMs: number): void {
    this.pairingPollTimer = setTimeout(() => {
      void this.pollPairingStatus()
    }, delayMs)
  }

  private stopPairingTimers(): void {
    if (this.pairingPollTimer) {
      clearTimeout(this.pairingPollTimer)
      this.pairingPollTimer = undefined
    }
  }

  private async pollPairingStatus(): Promise<void> {
    if (this.state === 'RECOVERY_REQUIRED') {
      await this.pollRecoveryStatus()
      return
    }

    if (this.state !== 'PAIRING_PENDING' && this.state !== 'PAIRING_CONFIRMED' && this.state !== 'PAIRING_COMPLETING') {
      return
    }

    const current = this.store.getState()
    if (!this.isPairingCodeStillValid(current.pairingExpiresAt)) {
      await this.pairingService.clearPairingMetadata()
      await this.enterHardRecovery('Fresh pairing code expired before completion')
      return
    }

    try {
      const status = await this.pairingService.fetchPairingStatus()
      const activePairing = status.active_pairing || null
      await this.syncActivePairingMetadata(activePairing)
      this.pairingPollBackoff.reset()

      if (activePairing?.mode === 'PAIRING' && activePairing.confirmed) {
        await this.transitionState('PAIRING_CONFIRMED', {
          error: 'Pairing confirmed. Provisioning credentials...',
        })
        await this.attemptPairingCompletion()
        return
      }

      await this.transitionState('PAIRING_PENDING', {
        error: 'Waiting for admin approval...',
      })
      this.schedulePairingStatusPoll(PAIRING_POLL_INTERVAL_MS)
    } catch (error) {
      logger.warn({ error }, 'Pairing status poll failed')
      const delay = this.pairingPollBackoff.getDelay()
      await this.transitionState('PAIRING_PENDING', {
        error: (error as Error).message,
      })
      this.schedulePairingStatusPoll(delay)
    }
  }

  private async pollRecoveryStatus(): Promise<void> {
    if (!this.pairingService.hasTrustworthyDeviceId()) {
      await this.enterHardRecovery('Stored device id is no longer usable')
      return
    }

    try {
      const status = await this.pairingService.fetchPairingStatus()
      const activePairing = status.active_pairing || null
      await this.syncActivePairingMetadata(activePairing)
      this.pairingPollBackoff.reset()

      if (activePairing?.mode === 'RECOVERY' && activePairing.confirmed) {
        if (!this.store.getState().pairingCode) {
          await this.transitionState('RECOVERY_REQUIRED', {
            error: 'Recovery pairing is confirmed but pairing code is not available yet.',
            recoveryReason: 'Recovery pairing is confirmed but pairing code is not available yet.',
          })
          this.schedulePairingStatusPoll(PAIRING_POLL_INTERVAL_MS)
          return
        }

        await this.transitionState('PAIRING_CONFIRMED', {
          error: 'Recovery confirmed. Provisioning replacement credentials...',
        })
        await this.attemptPairingCompletion()
        return
      }

      await this.transitionState('RECOVERY_REQUIRED', {
        error:
          activePairing?.mode === 'RECOVERY'
            ? 'Waiting for admin to confirm device recovery...'
            : 'Waiting for admin to start recovery for this screen identity...',
        recoveryReason: this.status.recoveryReason,
      })
      this.schedulePairingStatusPoll(PAIRING_POLL_INTERVAL_MS)
    } catch (error) {
      if (this.pairingService.isDeviceNotRegisteredError(error)) {
        await this.enterHardRecovery((error as Error).message || 'Device not registered in backend')
        return
      }

      logger.warn({ error }, 'Recovery status poll failed')
      await this.transitionState('RECOVERY_REQUIRED', {
        error: (error as Error).message,
        recoveryReason: this.status.recoveryReason,
      })
      this.schedulePairingStatusPoll(this.pairingPollBackoff.getDelay())
    }
  }

  private async syncActivePairingMetadata(activePairing: PairingStatusResponse['active_pairing']): Promise<void> {
    if (!activePairing) {
      return
    }

    await this.store.update({
      activePairingMode: activePairing.mode,
      pairingCode: activePairing.pairing_code || this.store.getState().pairingCode,
      pairingExpiresAt: activePairing.expires_at || this.store.getState().pairingExpiresAt,
    })
  }

  private async attemptPairingCompletion(): Promise<PairingResponse | null> {
    const currentMode = this.store.getState().activePairingMode
    const pairingCode = this.pairingService.getLastPairingCode()

    if (!pairingCode) {
      if (currentMode === 'RECOVERY') {
        await this.enterRecoveryRequired('Recovery pairing is missing a pairing code')
      } else {
        await this.enterHardRecovery('Fresh pairing is missing a pairing code')
      }
      return null
    }

    await this.transitionState('PAIRING_COMPLETING', {
      error: 'Generating key and CSR, then requesting device certificate...',
    })

    try {
      const response = await this.pairingService.submitPairing(pairingCode)
      await this.bootstrapAuthenticatedRuntime()
      return response
    } catch (error) {
      if (this.pairingService.isPairingNotConfirmedError(error)) {
        if (currentMode === 'RECOVERY') {
          await this.enterRecoveryRequired('Recovery pairing is not confirmed yet. Continuing to poll...')
        } else {
          await this.transitionState('PAIRING_PENDING', {
            error: 'Pairing not confirmed yet. Continuing to poll...',
          })
          this.startPairingStatusPolling()
        }
        return null
      }

      if (this.pairingService.isExpiredPairingCodeError(error)) {
        await this.pairingService.clearPairingMetadata()
        if (currentMode === 'RECOVERY') {
          await this.enterRecoveryRequired('Recovery pairing expired. Waiting for admin to create a new recovery pairing...')
        } else {
          await this.enterHardRecovery('Fresh pairing code expired before completion')
        }
        return null
      }

      if (currentMode === 'RECOVERY') {
        await this.enterRecoveryRequired((error as Error).message || 'Failed to complete recovery pairing')
        return null
      }

      await this.transitionState('PAIRING_CONFIRMED', {
        error: (error as Error).message,
      })
      this.schedulePairingStatusPoll(this.pairingPollBackoff.getDelay())
      return null
    }
  }

  private async retryRecovery(): Promise<void> {
    const identity = this.pairingService.getStoredIdentityHealth()
    const trustworthyDeviceId = this.pairingService.hasTrustworthyDeviceId()

    if (identity.health === 'complete' && trustworthyDeviceId) {
      await this.bootstrapAuthenticatedRuntime()
      return
    }

    if (trustworthyDeviceId) {
      await this.enterRecoveryRequired(identity.issues.join('. ') || 'Device identity requires recovery')
      return
    }

    await this.enterHardRecovery('Stored device identity is not recoverable')
  }

  private async handleRuntimeAuthFailure(event: RuntimeAuthFailureEvent): Promise<void> {
    logger.warn({ source: event.source, code: event.error.code, message: event.error.message }, 'Runtime auth failure received')

    if (
      this.state === 'PAIRING_PENDING' ||
      this.state === 'PAIRING_CONFIRMED' ||
      this.state === 'PAIRING_COMPLETING' ||
      this.state === 'HARD_RECOVERY'
    ) {
      return
    }

    if (this.pairingService.isDeviceNotRegisteredError(event.error)) {
      await this.enterHardRecovery('Device not registered in backend')
      return
    }

    if (this.pairingService.isInvalidCredentialError(event.error)) {
      await this.enterRecoveryRequired(event.error.message || 'Device credentials are no longer valid')
      return
    }

    if (this.pairingService.hasTrustworthyDeviceId()) {
      await this.enterRecoveryRequired(event.error.message || 'Device authentication requires recovery')
      return
    }

    await this.enterHardRecovery(event.error.message || 'Stored device identity is unusable')
  }

  private isPairingCodeStillValid(expiresAt?: string): boolean {
    if (!expiresAt) return false
    const parsed = Date.parse(expiresAt)
    return !Number.isNaN(parsed) && parsed > Date.now()
  }

  private async transitionState(next: PlayerState, statusPatch: Partial<PlayerStatus> = {}): Promise<void> {
    this.state = next
    await this.store.setLifecycleState(next)

    if (next === 'PAIRING_PENDING' || next === 'PAIRING_CONFIRMED' || next === 'PAIRING_COMPLETING') {
      this.updateStatus({
        mode: 'empty',
        online: false,
        ...statusPatch,
      })
    } else {
      this.updateStatus(statusPatch)
    }

    logger.info({ state: next }, 'Player state updated')
  }

  private refreshStatusFromState(): void {
    const persisted = this.store.getState()
    this.status = {
      ...this.status,
      state: persisted.lifecycleState || this.state,
      deviceId: persisted.deviceId,
      pairingCode: persisted.pairingCode,
      pairingExpiresAt: persisted.pairingExpiresAt,
      recoveryReason: persisted.recoveryReason,
      hardRecoveryDeadlineAt: persisted.hardRecoveryDeadlineAt,
      lastHeartbeatAt: persisted.lastHeartbeatAt,
    }
    this.emitStatus()
  }

  private updateStatus(update: Partial<PlayerStatus>): void {
    this.status = {
      ...this.status,
      ...update,
    }
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit('status', this.status)
    if (this.mainWindow) {
      this.mainWindow.webContents.send('player-status', this.status)
    }
  }
}

let playerFlow: PlayerFlow | null = null

export function getPlayerFlow(): PlayerFlow {
  if (!playerFlow) {
    playerFlow = new PlayerFlow()
  }
  return playerFlow
}
