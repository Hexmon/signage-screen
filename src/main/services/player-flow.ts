/**
 * Player Flow - State machine for device boot, pairing, and playback
 */

import { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { PairingCodeRequest, PlayerState, PlayerStatus } from '../../common/types'
import { getCertificateManager } from './cert-manager'
import { getPairingService } from './pairing-service'
import { getSnapshotManager, PlaybackPlaylist } from './snapshot-manager'
import { getPlaybackEngine } from './playback/playback-engine'
import { getTelemetryService } from './telemetry/telemetry-service'
import { getCommandProcessor } from './command-processor'
import { getScreenshotService } from './screenshot-service'

const logger = getLogger('player-flow')

export class PlayerFlow extends EventEmitter {
  private state: PlayerState = 'BOOT'
  private status: PlayerStatus = {
    state: 'BOOT',
    mode: 'empty',
    online: false,
  }
  private mainWindow?: BrowserWindow
  private playbackStarted = false
  private screenshotInterval?: NodeJS.Timeout

  initialize(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow

    const playbackEngine = getPlaybackEngine()
    playbackEngine.initialize(mainWindow)
    playbackEngine.on('item-playing', (item) => {
      this.updateStatus({ currentMediaId: item.mediaId || item.id })
    })

    const screenshotService = getScreenshotService()
    screenshotService.initialize(mainWindow)
  }

  async start(): Promise<void> {
    this.transitionState('BOOT')

    const pairingService = getPairingService()
    const certManager = getCertificateManager()

    const deviceId = pairingService.getDeviceId()
    const hasCerts = certManager.areCertificatesPresent()

    this.updateStatus({
      deviceId,
    })

    if (!deviceId || !hasCerts) {
      this.transitionState('NEED_PAIRING')
      return
    }

    await this.startPlaybackLoop()
  }

  getState(): PlayerState {
    return this.state
  }

  getStatus(): PlayerStatus {
    return { ...this.status }
  }

  async requestPairingCode(overrides?: Partial<PairingCodeRequest>): Promise<any> {
    this.transitionState('PAIRING_REQUESTED')

    const pairingService = getPairingService()
    const response = await pairingService.requestPairingCode(overrides)

    this.updateStatus({
      deviceId: response.device_id || pairingService.getDeviceId(),
    })

    this.transitionState('WAITING_CONFIRMATION')
    return response
  }

  async checkPairingStatus(): Promise<any> {
    const pairingService = getPairingService()
    const status = await pairingService.fetchPairingStatus()

    if (status.paired) {
      this.transitionState('WAITING_CONFIRMATION')
    }

    return status
  }

  async completePairing(pairingCode?: string): Promise<any> {
    const pairingService = getPairingService()
    const code = pairingCode || pairingService.getLastPairingCode()

    if (!code) {
      throw new Error('No pairing code available to complete pairing')
    }

    this.transitionState('CERT_ISSUED')
    try {
      const response = await pairingService.submitPairing(code)

      this.updateStatus({
        deviceId: response.device_id || pairingService.getDeviceId(),
      })

      await this.startPlaybackLoop()
      return response
    } catch (error) {
      const status = (error as any)?.status
      if (status === 404) {
        this.transitionState('NEED_PAIRING')
        const newCode = await pairingService.requestPairingCode()
        this.updateStatus({
          deviceId: newCode.device_id || pairingService.getDeviceId(),
        })
        return newCode
      }
      throw error
    }
  }

  async refreshSnapshot(): Promise<void> {
    const snapshotManager = getSnapshotManager()
    await snapshotManager.refreshSnapshot()
  }

  async stop(): Promise<void> {
    this.stopPlaybackLoop()
  }

  private async startPlaybackLoop(): Promise<void> {
    if (this.playbackStarted) {
      return
    }

    this.playbackStarted = true
    const telemetryService = getTelemetryService()
    const commandProcessor = getCommandProcessor()
    const snapshotManager = getSnapshotManager()
    const playbackEngine = getPlaybackEngine()

    if (this.mainWindow && this.mainWindow.webContents.isLoading()) {
      await new Promise<void>((resolve) => {
        this.mainWindow?.webContents.once('did-finish-load', () => resolve())
      })
    }

    snapshotManager.on('playlist-updated', (playlist: PlaybackPlaylist) => {
      this.handlePlaylistUpdate(playlist)
    })

    commandProcessor.start()
    await telemetryService.start()

    snapshotManager.start()
    try {
      await snapshotManager.refreshSnapshot()
      const playlist = snapshotManager.getCurrentPlaylist()
      if (playlist && playlist.items.length > 0) {
        await playbackEngine.start()
      }

      if (playlist && (playlist.mode === 'offline' || playlist.mode === 'empty')) {
        this.transitionState('OFFLINE_FALLBACK')
      } else {
        this.transitionState('PLAYBACK_RUNNING')
      }
    } catch (error) {
      logger.warn({ error }, 'Playback start deferred until playlist is available')
      this.transitionState('OFFLINE_FALLBACK')
    }

    this.startScreenshotLoop()
  }

  private stopPlaybackLoop(): void {
    const telemetryService = getTelemetryService()
    const commandProcessor = getCommandProcessor()
    const snapshotManager = getSnapshotManager()
    const playbackEngine = getPlaybackEngine()

    commandProcessor.stop()
    telemetryService.stop().catch((error) => {
      logger.error({ error }, 'Failed to stop telemetry service')
    })
    snapshotManager.stop()
    playbackEngine.stop()

    this.stopScreenshotLoop()
    this.playbackStarted = false
  }

  private handlePlaylistUpdate(playlist: PlaybackPlaylist): void {
    const online = playlist.mode !== 'offline' && playlist.mode !== 'empty'

    if (playlist.mode === 'offline' || playlist.mode === 'empty') {
      this.transitionState('OFFLINE_FALLBACK')
    } else if (this.state !== 'PLAYBACK_RUNNING') {
      this.transitionState('PLAYBACK_RUNNING')
    }

    this.updateStatus({
      mode: playlist.mode,
      online,
      scheduleId: playlist.scheduleId,
      lastSnapshotAt: playlist.lastSnapshotAt,
    })
  }

  private startScreenshotLoop(): void {
    this.stopScreenshotLoop()

    const intervalMs = getConfigManager().getConfig().intervals.screenshotMs

    const screenshotService = getScreenshotService()
    this.screenshotInterval = setInterval(() => {
      screenshotService.captureAndUpload().catch((error) => {
        logger.warn({ error }, 'Screenshot upload failed')
      })
    }, intervalMs)
  }

  private stopScreenshotLoop(): void {
    if (this.screenshotInterval) {
      clearInterval(this.screenshotInterval)
      this.screenshotInterval = undefined
    }
  }

  private transitionState(next: PlayerState, error?: string): void {
    if (this.state === next) {
      return
    }

    this.state = next
    const statusUpdate: Partial<PlayerStatus> = {
      state: next,
      error,
    }

    if (next === 'NEED_PAIRING' || next === 'PAIRING_REQUESTED' || next === 'WAITING_CONFIRMATION') {
      statusUpdate.online = false
      statusUpdate.mode = 'empty'
    }

    if (next === 'OFFLINE_FALLBACK') {
      statusUpdate.online = false
      statusUpdate.mode = this.status.mode === 'empty' ? 'offline' : this.status.mode
    }

    this.updateStatus(statusUpdate)

    logger.info({ state: next }, 'Player state updated')
  }

  private updateStatus(update: Partial<PlayerStatus>): void {
    this.status = { ...this.status, ...update }
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
