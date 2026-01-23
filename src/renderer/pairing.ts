/**
 * Pairing Screen Logic
 * Handles device pairing UI and network diagnostics
 */

import type { PairingCodeRequest, PairingCodeResponse, PairingStatusResponse, PlayerStatus } from '../common/types'
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

  private statusPollTimer?: number
  private expiryTimer?: number
  private expiresAt?: number
  private requestingCode = false
  private completingPairing = false

  constructor() {
    this.initializeElements()
    this.setupEventListeners()
    this.bootstrapPairing()
    this.runDiagnostics()
    this.listenForStatusUpdates()
  }

  /**
   * Initialize DOM elements
   */
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
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    this.refreshButton?.addEventListener('click', () => {
      this.requestPairingCode(true).catch((error) => {
        console.error('[Pairing] Failed to refresh pairing code:', error)
      })
    })

    this.completeButton?.addEventListener('click', () => {
      this.completePairing().catch((error) => {
        console.error('[Pairing] Failed to complete pairing:', error)
      })
    })
  }

  /**
   * Bootstrap pairing status and code
   */
  private async bootstrapPairing(): Promise<void> {
    await this.populateDeviceInfo()

    const status = await this.refreshPairingStatus()

    if (!status || !status.paired) {
      await this.requestPairingCode(false)
      this.startStatusPolling()
    }
  }

  private listenForStatusUpdates(): void {
    if (window.hexmon?.onPlayerStatus) {
      window.hexmon.onPlayerStatus((data: any) => {
        const status = data as PlayerStatus
        if (status.state === 'PLAYBACK_RUNNING' || status.state === 'OFFLINE_FALLBACK') {
          this.hidePairingScreen()
        } else if (status.state === 'NEED_PAIRING' || status.state === 'PAIRING_REQUESTED' || status.state === 'WAITING_CONFIRMATION') {
          this.showPairingScreen()
        }
      })
    }
  }

  private async populateDeviceInfo(): Promise<void> {
    try {
      const info = await window.hexmon.getDeviceInfo()
      if (this.deviceLabelInput && info && typeof info === 'object') {
        const hostname = (info as any).hostname || ''
        this.deviceLabelInput.value = hostname
      }

      const width = window.screen.width
      const height = window.screen.height
      if (this.resolutionElement) {
        this.resolutionElement.textContent = `${width} × ${height}`
      }

      if (this.modelElement && info && typeof info === 'object') {
        this.modelElement.textContent = `${(info as any).platform || 'Unknown'} ${(info as any).arch || ''}`
      }
    } catch (error) {
      console.error('[Pairing] Failed to load device info:', error)
    }
  }

  /**
   * Check pairing status and show/hide screen accordingly
   */
  private async refreshPairingStatus(): Promise<PairingStatusResponse | null> {
    try {
      const status = await window.hexmon.getPairingStatus()

      if (status.paired) {
        this.enableCompleteButton(true)
        if (!this.completingPairing) {
          this.completePairing().catch((error) => {
            console.error('[Pairing] Auto-complete failed:', error)
          })
        }
      }

      if (status.device_id && this.deviceIdElement) {
        this.deviceIdElement.textContent = status.device_id
      }

      if (status.paired) {
        this.showStatus('Pairing approved. Complete setup to fetch certificate.', 'success')
      }

      return status
    } catch (error) {
      console.error('[Pairing] Failed to check pairing status:', error)
      this.showPairingScreen()
      this.showStatus('Unable to check pairing status. Retrying...', 'error')
      return null
    }
  }

  /**
   * Request a pairing code from backend
   */
  private async requestPairingCode(force: boolean): Promise<void> {
    if (this.requestingCode) return

    if (!force && this.expiresAt && Date.now() < this.expiresAt) {
      return
    }

    this.requestingCode = true
    this.showStatus('Generating pairing code...', '')
    this.updatePairingCode('------')

    try {
      const payload = this.buildPairingRequestPayload()
      const response = await window.hexmon.requestPairingCode(payload)
      this.applyPairingResponse(response)
      this.showStatus('Enter this code in your CMS to connect.', '')
      this.enableCompleteButton(false)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to generate pairing code'
      this.showStatus(errorMessage, 'error')
    } finally {
      this.requestingCode = false
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

  /**
   * Complete pairing and fetch certificate
   */
  private async completePairing(): Promise<void> {
    if (this.completingPairing) return

    this.completingPairing = true
    this.showStatus('Completing pairing, requesting certificate...', '')

    try {
      await window.hexmon.completePairing()
      this.showStatus('Certificate issued. Starting playback...', 'success')
      this.hidePairingScreen()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to complete pairing'
      this.showStatus(errorMessage, 'error')
      this.enableCompleteButton(true)
    } finally {
      this.completingPairing = false
    }
  }

  /**
   * Show the pairing screen
   */
  private showPairingScreen(): void {
    if (this.pairingScreenElement) {
      this.pairingScreenElement.classList.remove('hidden')
    }
  }

  /**
   * Hide the pairing screen
   */
  private hidePairingScreen(): void {
    if (this.pairingScreenElement) {
      this.pairingScreenElement.classList.add('hidden')
    }
    this.stopStatusPolling()
  }

  /**
   * Apply pairing response details to UI
   */
  private applyPairingResponse(response: PairingCodeResponse): void {
    const code = response.pairing_code ? String(response.pairing_code).toUpperCase() : '------'
    this.updatePairingCode(code)
    this.setExpiry(response)
    this.startExpiryTimer()

    if (response.device_id && this.deviceIdElement) {
      this.deviceIdElement.textContent = response.device_id
    }
  }

  private updatePairingCode(code: string): void {
    if (!this.pairingCodeElement) return

    const formatted = code.split('').join(' ')
    this.pairingCodeElement.textContent = formatted
  }

  private setExpiry(response: PairingCodeResponse): void {
    if (response.expires_at) {
      const parsed = Date.parse(response.expires_at)
      if (!Number.isNaN(parsed)) {
        this.expiresAt = parsed
        return
      }
    }

    if (response.expires_in) {
      this.expiresAt = Date.now() + response.expires_in * 1000
      return
    }

    this.expiresAt = undefined
  }

  private startStatusPolling(): void {
    if (this.statusPollTimer) return

    this.statusPollTimer = window.setInterval(() => {
      this.refreshPairingStatus().catch((error) => {
        console.error('[Pairing] Status poll failed:', error)
      })
    }, 5000)
  }

  private stopStatusPolling(): void {
    if (this.statusPollTimer) {
      window.clearInterval(this.statusPollTimer)
      this.statusPollTimer = undefined
    }
  }

  private startExpiryTimer(): void {
    this.stopExpiryTimer()
    this.updateExpiryDisplay()

    this.expiryTimer = window.setInterval(() => {
      this.updateExpiryDisplay()
    }, 1000)
  }

  private stopExpiryTimer(): void {
    if (this.expiryTimer) {
      window.clearInterval(this.expiryTimer)
      this.expiryTimer = undefined
    }
  }

  private updateExpiryDisplay(): void {
    if (!this.pairingExpiryElement) return

    if (!this.expiresAt) {
      this.pairingExpiryElement.textContent = 'Expires in --:--'
      return
    }

    const remainingMs = this.expiresAt - Date.now()
    if (remainingMs <= 0) {
      this.pairingExpiryElement.textContent = 'Code expired, requesting a new one...'
      this.requestPairingCode(true).catch((error) => {
        console.error('[Pairing] Failed to refresh expired code:', error)
      })
      return
    }

    const totalSeconds = Math.floor(remainingMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    this.pairingExpiryElement.textContent = `Expires in ${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  /**
   * Show status message
   */
  private showStatus(message: string, type: 'success' | 'error' | ''): void {
    if (!this.statusElement) return

    this.statusElement.textContent = message
    this.statusElement.className = `pairing-status ${type}`
  }

  private enableCompleteButton(enabled: boolean): void {
    if (!this.completeButton) return
    this.completeButton.disabled = !enabled
  }

  /**
   * Run network diagnostics
   */
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
      console.error('Failed to run diagnostics:', error)
      this.diagnosticsList.innerHTML = '<li>Failed to run diagnostics</li>'
    }
  }

  /**
   * Create diagnostic item HTML
   */
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

// Initialize pairing screen when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new PairingScreen()
  })
} else {
  new PairingScreen()
}
