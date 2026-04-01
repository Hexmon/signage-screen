import type { PairingCodeRequest, PlayerStatus } from '../common/types'
import './types'

class PairingScreen {
  private pairingCodeElement: HTMLElement | null = null
  private pairingExpiryElement: HTMLElement | null = null
  private refreshButton: HTMLButtonElement | null = null
  private completeButton: HTMLButtonElement | null = null
  private statusElement: HTMLElement | null = null
  private diagnosticsList: HTMLElement | null = null
  private pairingScreenElement: HTMLElement | null = null
  private deviceIdElement: HTMLElement | null = null
  private deviceLabelInput: HTMLInputElement | null = null
  private resolutionElement: HTMLElement | null = null
  private modelElement: HTMLElement | null = null
  private recoveryOverlay: HTMLElement | null = null
  private recoveryTitle: HTMLElement | null = null
  private recoveryReason: HTMLElement | null = null
  private recoveryMeta: HTMLElement | null = null
  private recoveryRetryButton: HTMLButtonElement | null = null
  private recoveryRepairButton: HTMLButtonElement | null = null
  private connectivityBanner: HTMLElement | null = null
  private countdownTimer?: number
  private currentStatus: PlayerStatus | null = null

  constructor() {
    this.initializeElements()
    this.setupEventListeners()
    this.populateDeviceInfo().catch((error) => {
      console.error('[Pairing] Failed to populate device info', error)
    })
    this.bootstrap().catch((error) => {
      console.error('[Pairing] Bootstrap failed', error)
    })
    this.runDiagnostics().catch((error) => {
      console.error('[Pairing] Diagnostics failed', error)
    })
  }

  private initializeElements(): void {
    this.pairingScreenElement = document.getElementById('pairing-screen')
    this.pairingCodeElement = document.getElementById('pairing-code')
    this.pairingExpiryElement = document.getElementById('pairing-expiry')
    this.refreshButton = document.getElementById('pairing-refresh') as HTMLButtonElement
    this.completeButton = document.getElementById('pairing-complete') as HTMLButtonElement
    this.statusElement = document.getElementById('pairing-status')
    this.diagnosticsList = document.getElementById('diagnostics-list')
    this.deviceIdElement = document.getElementById('pairing-device-id')
    this.deviceLabelInput = document.getElementById('device-label') as HTMLInputElement
    this.resolutionElement = document.getElementById('device-resolution')
    this.modelElement = document.getElementById('device-model')
    this.recoveryOverlay = document.getElementById('recovery-overlay')
    this.recoveryTitle = document.getElementById('recovery-title')
    this.recoveryReason = document.getElementById('recovery-reason')
    this.recoveryMeta = document.getElementById('recovery-meta')
    this.recoveryRetryButton = document.getElementById('recovery-retry') as HTMLButtonElement
    this.recoveryRepairButton = document.getElementById('recovery-repair') as HTMLButtonElement
    this.connectivityBanner = document.getElementById('connectivity-banner')
  }

  private setupEventListeners(): void {
    this.refreshButton?.addEventListener('click', () => {
      void window.hexmon.playerAction('refresh-pairing', this.buildPairingRequestPayload())
    })

    this.completeButton?.addEventListener('click', () => {
      void window.hexmon.completePairing()
    })

    this.recoveryRetryButton?.addEventListener('click', () => {
      void window.hexmon.playerAction('retry-recovery')
    })

    this.recoveryRepairButton?.addEventListener('click', () => {
      void window.hexmon.playerAction('re-pair', this.buildPairingRequestPayload())
    })
  }

  private async bootstrap(): Promise<void> {
    const initialStatus = (await window.hexmon.getPlayerStatus()) as PlayerStatus
    this.render(initialStatus)

    window.hexmon.onPlayerStatus((data: unknown) => {
      this.render(data as PlayerStatus)
    })
  }

  private async populateDeviceInfo(): Promise<void> {
    const info = await window.hexmon.getDeviceInfo()
    if (this.deviceLabelInput && info && typeof info === 'object') {
      const hostname = (info as { hostname?: string }).hostname || ''
      this.deviceLabelInput.value = hostname
    }

    const width = window.screen.width
    const height = window.screen.height
    if (this.resolutionElement) {
      this.resolutionElement.textContent = `${width} × ${height}`
    }

    if (this.modelElement && info && typeof info === 'object') {
      const typedInfo = info as { platform?: string; arch?: string }
      this.modelElement.textContent = `${typedInfo.platform || 'Unknown'} ${typedInfo.arch || ''}`.trim()
    }
  }

  private render(status: PlayerStatus): void {
    this.currentStatus = status
    this.renderPairingState(status)
    this.renderRecoveryState(status)
    this.renderConnectivity(status)
    this.renderSharedFields(status)
    this.startCountdowns()
  }

  private renderPairingState(status: PlayerStatus): void {
    const showConfigurationRequired =
      status.state === 'BOOT' &&
      typeof status.error === 'string' &&
      status.error.toLowerCase().includes('configuration required')
    const showPairing =
      showConfigurationRequired ||
      ['PAIRING_PENDING', 'PAIRING_CONFIRMED', 'PAIRING_COMPLETING'].includes(status.state)

    this.pairingScreenElement?.classList.toggle('hidden', !showPairing)

    if (!showPairing) {
      return
    }

    if (showConfigurationRequired) {
      this.updatePairingCode('CONFIG')
      this.updatePairingExpiry(undefined)
      this.showStatus(status.error || 'Backend IP configuration is required before pairing.', 'error')
      if (this.refreshButton) {
        this.refreshButton.disabled = true
      }
      this.enableCompleteButton(false)
      return
    }

    if (this.refreshButton) {
      this.refreshButton.disabled = false
    }

    this.updatePairingCode(status.pairingCode || '------')
    this.updatePairingExpiry(status.pairingExpiresAt)

    switch (status.state) {
      case 'PAIRING_PENDING':
        this.showStatus(status.error || 'Waiting for admin approval...', '')
        this.enableCompleteButton(false)
        break
      case 'PAIRING_CONFIRMED':
        this.showStatus(status.error || 'Pairing confirmed. Provisioning credentials...', 'success')
        this.enableCompleteButton(true)
        break
      case 'PAIRING_COMPLETING':
        this.showStatus(status.error || 'Completing pairing...', '')
        this.enableCompleteButton(false)
        break
      default:
        this.enableCompleteButton(false)
        break
    }
  }

  private renderRecoveryState(status: PlayerStatus): void {
    const showRecovery = status.state === 'RECOVERY_REQUIRED' || status.state === 'HARD_RECOVERY'
    this.recoveryOverlay?.classList.toggle('hidden', !showRecovery)

    if (!showRecovery) {
      return
    }

    if (this.recoveryTitle) {
      this.recoveryTitle.textContent = status.state === 'HARD_RECOVERY' ? 'Fresh Pairing Required' : 'Recovery Required'
    }

    if (this.recoveryReason) {
      this.recoveryReason.textContent = status.recoveryReason || status.error || 'Runtime authentication requires attention.'
    }

    if (this.recoveryRetryButton) {
      this.recoveryRetryButton.disabled = status.state === 'HARD_RECOVERY'
    }

    if (this.recoveryMeta) {
      if (status.state === 'HARD_RECOVERY' && status.hardRecoveryDeadlineAt) {
        this.recoveryMeta.textContent = this.formatDeadline(status.hardRecoveryDeadlineAt, 'Fresh pairing starts in')
      } else if (status.lastHeartbeatAt) {
        this.recoveryMeta.textContent = `Last heartbeat: ${new Date(status.lastHeartbeatAt).toLocaleString()}`
      } else {
        this.recoveryMeta.textContent = 'Playback continues from cached content when available.'
      }
    }
  }

  private renderConnectivity(status: PlayerStatus): void {
    if (!this.connectivityBanner) {
      return
    }

    if (status.state === 'BOOT') {
      this.connectivityBanner.textContent = status.error || 'Starting player...'
      this.connectivityBanner.classList.remove('hidden')
      return
    }

    if (status.state === 'BOOTSTRAP_AUTH') {
      this.connectivityBanner.textContent = status.error || 'Validating device access...'
      this.connectivityBanner.classList.remove('hidden')
      return
    }

    if (status.state === 'SOFT_RECOVERY') {
      this.connectivityBanner.textContent = status.error || 'Backend unavailable. Retrying while cached playback continues.'
      this.connectivityBanner.classList.remove('hidden')
      return
    }

    if (status.backendAvailable === false && status.state === 'PAIRED_RUNTIME') {
      this.connectivityBanner.textContent = 'Backend unavailable. Playback continues from cached content.'
      this.connectivityBanner.classList.remove('hidden')
      return
    }

    this.connectivityBanner.classList.add('hidden')
  }

  private renderSharedFields(status: PlayerStatus): void {
    if (this.deviceIdElement) {
      this.deviceIdElement.textContent = status.deviceId || '-'
    }
  }

  private buildPairingRequestPayload(): Partial<PairingCodeRequest> {
    const width = window.screen.width
    const height = window.screen.height
    const orientation = width >= height ? 'landscape' : 'portrait'
    const aspectRatio = this.getAspectRatio(width, height)

    return {
      device_label: this.deviceLabelInput?.value?.trim() || 'Hexmon Screen',
      width,
      height,
      orientation,
      aspect_ratio: aspectRatio,
      model: this.modelElement?.textContent || 'unknown',
      codecs: ['h264'],
      device_info: {
        os: navigator.userAgent,
      },
    }
  }

  private updatePairingCode(code: string): void {
    if (!this.pairingCodeElement) return
    this.pairingCodeElement.textContent = code.split('').join(' ')
  }

  private updatePairingExpiry(expiresAt?: string): void {
    if (!this.pairingExpiryElement) return
    if (!expiresAt) {
      this.pairingExpiryElement.textContent = 'Expires in --:--'
      return
    }

    this.pairingExpiryElement.textContent = this.formatDeadline(expiresAt, 'Expires in')
  }

  private startCountdowns(): void {
    if (this.countdownTimer) {
      window.clearInterval(this.countdownTimer)
      this.countdownTimer = undefined
    }

    this.countdownTimer = window.setInterval(() => {
      if (!this.currentStatus) {
        return
      }
      this.updatePairingExpiry(this.currentStatus.pairingExpiresAt)
      if (this.recoveryMeta && this.currentStatus.state === 'HARD_RECOVERY' && this.currentStatus.hardRecoveryDeadlineAt) {
        this.recoveryMeta.textContent = this.formatDeadline(this.currentStatus.hardRecoveryDeadlineAt, 'Fresh pairing starts in')
      }
    }, 1000)
  }

  private formatDeadline(deadline: string, prefix: string): string {
    const target = Date.parse(deadline)
    if (Number.isNaN(target)) {
      return `${prefix} --:--`
    }

    const remainingMs = target - Date.now()
    if (remainingMs <= 0) {
      return `${prefix} 0:00`
    }

    const totalSeconds = Math.floor(remainingMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${prefix} ${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  private showStatus(message: string, type: 'success' | 'error' | ''): void {
    if (!this.statusElement) return
    this.statusElement.textContent = message
    this.statusElement.className = `pairing-status ${type}`
  }

  private enableCompleteButton(enabled: boolean): void {
    if (!this.completeButton) return
    this.completeButton.disabled = !enabled
  }

  private async runDiagnostics(): Promise<void> {
    if (!this.diagnosticsList) return

    try {
      const diagnostics = await window.hexmon.getDiagnostics()
      const items: string[] = []
      items.push(this.createDiagnosticItem('Hostname', diagnostics.hostname || 'Unknown', true))
      items.push(this.createDiagnosticItem('IP Address', diagnostics.ipAddresses?.join(', ') || diagnostics.ipAddress, true))
      items.push(this.createDiagnosticItem('DNS Resolution', diagnostics.dnsResolution ? 'OK' : 'Failed', diagnostics.dnsResolution ?? false))
      items.push(this.createDiagnosticItem('API Reachable', diagnostics.apiReachable ? 'OK' : 'Failed', diagnostics.apiReachable ?? false))
      if (diagnostics.latency) {
        items.push(this.createDiagnosticItem('Latency', `${diagnostics.latency}ms`, true))
      }
      this.diagnosticsList.innerHTML = items.join('')
    } catch (error) {
      this.diagnosticsList.innerHTML = '<li>Failed to run diagnostics</li>'
    }
  }

  private createDiagnosticItem(label: string, value: string, status: boolean): string {
    const indicator = status ? 'online' : 'offline'
    return `
      <li>
        <span><span class="status-indicator ${indicator}"></span>${label}:</span>
        <span>${value}</span>
      </li>
    `
  }

  private getAspectRatio(width: number, height: number): string {
    const divisor = this.getGreatestCommonDivisor(width, height)
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`
  }

  private getGreatestCommonDivisor(a: number, b: number): number {
    let x = Math.abs(a)
    let y = Math.abs(b)
    while (y !== 0) {
      const temp = y
      y = x % y
      x = temp
    }
    return x || 1
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new PairingScreen()
  })
} else {
  new PairingScreen()
}
