/**
 * Pairing Service - Device pairing with CSR generation
 * Handles the complete pairing flow including certificate generation and storage
 */

import * as os from 'os'
import { app, screen } from 'electron'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import {
  DeviceInfo,
  PairingCodeRequest,
  PairingCodeResponse,
  PairingRequest,
  PairingResponse,
  PairingStatusResponse,
} from '../../common/types'
import { getCertificateManager } from './cert-manager'
import { getHttpClient } from './network/http-client'

const logger = getLogger('pairing-service')

export interface NetworkDiagnostics {
  hostname: string
  ipAddresses: string[]
  dnsResolution: boolean
  apiReachable: boolean
  wsReachable: boolean
  latency?: number
}

export class PairingService {
  private isPaired = false
  private deviceId?: string
  private lastPairingCode?: string
  private pairingExpiresAt?: string

  constructor() {
    this.loadPairingStatus()
  }

  /**
   * Load pairing status from config
   */
  private loadPairingStatus(): void {
    const config = getConfigManager().getConfig()
    this.deviceId = config.deviceId
    const certManager = getCertificateManager()
    this.isPaired = Boolean(this.deviceId && certManager.areCertificatesPresent())

    logger.info({ isPaired: this.isPaired, deviceId: this.deviceId }, 'Pairing status loaded')
  }

  /**
   * Check if device is paired
   */
  isPairedDevice(): boolean {
    return this.isPaired
  }

  /**
   * Get device ID
   */
  getDeviceId(): string | undefined {
    return this.deviceId
  }

  /**
   * Get device information
   */
  getDeviceInfo(): DeviceInfo {
    return {
      deviceId: this.deviceId || '',
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
    }
  }

  /**
   * Submit pairing request
   */
  async submitPairing(pairingCode: string): Promise<PairingResponse> {
    logger.info({ pairingCode }, 'Submitting pairing request')

    try {
      // Validate pairing code format
      if (!/^[A-Z0-9]{6}$/.test(pairingCode)) {
        throw new Error('Invalid pairing code format. Must be 6 alphanumeric characters.')
      }

      // Get device info
      const deviceInfo = this.getDeviceInfo()

      // Generate CSR
      const certManager = getCertificateManager()
      const csr = await certManager.generateCSR(deviceInfo, {
        commonName: deviceInfo.deviceId || this.deviceId || deviceInfo.hostname,
      })

      // Prepare pairing request
      const request: PairingRequest = {
        pairing_code: pairingCode,
        csr,
      }

      // Submit to backend
      const httpClient = getHttpClient()
      const response = await httpClient.post<PairingResponse>('/api/v1/device-pairing/complete', request, {
        mtls: false,
      })

      if (response.success === false) {
        throw new Error('Pairing request was rejected by the server')
      }

      // Complete pairing
      await this.completePairing(response)

      logger.info({ deviceId: response.device_id }, 'Pairing completed successfully')
      return response
    } catch (error) {
      logger.error({ error, pairingCode }, 'Pairing failed')
      throw error
    }
  }

  /**
   * Fetch pairing status from backend
   */
  async fetchPairingStatus(): Promise<PairingStatusResponse> {
    const deviceId = this.deviceId

    if (!deviceId) {
      return {
        device_id: '',
        paired: false,
        screen: null,
      }
    }

    const httpClient = getHttpClient()
    const status = await httpClient.get<PairingStatusResponse>(
      `/api/v1/device-pairing/status?device_id=${encodeURIComponent(deviceId)}`,
      { mtls: false }
    )

    this.updatePairingState(status.device_id, status.paired)
    return status
  }

  /**
   * Request a new pairing code from backend
   */
  async requestPairingCode(overrides: Partial<PairingCodeRequest> = {}): Promise<PairingCodeResponse> {
    const httpClient = getHttpClient()
    const payload = this.buildPairingCodeRequest(overrides)
    const response = await httpClient.post<PairingCodeResponse>('/api/v1/device-pairing/request', payload, {
      mtls: false,
    })

    if (response.device_id) {
      this.updatePairingState(response.device_id, false)
    }

    if (response.pairing_code) {
      this.lastPairingCode = response.pairing_code
    }
    this.pairingExpiresAt = response.expires_at

    return response
  }

  /**
   * Complete pairing and store credentials
   */
  async completePairing(response: PairingResponse): Promise<void> {
    logger.info({ deviceId: response.device_id, success: response.success }, 'Completing pairing')

    try {
      const config = getConfigManager()
      const currentConfig = config.getConfig()

      if (!response.device_id) {
        throw new Error('Pairing response missing device_id')
      }

      // Store certificates if provided
      const hasCertificates = !!(response.certificate && response.ca_certificate)
      if (hasCertificates) {
        const certManager = getCertificateManager()
        await certManager.storeCertificate(response.certificate!, response.ca_certificate!)
      }

      // Update configuration
      config.updateConfig({
        deviceId: response.device_id,
        apiBase: response.api_base || currentConfig.apiBase,
        wsUrl: response.ws_url || currentConfig.wsUrl,
        mtls: {
          ...currentConfig.mtls,
          enabled: hasCertificates ? true : currentConfig.mtls.enabled,
        },
      })

      // Update internal state
      this.deviceId = response.device_id
      this.isPaired = true

      const httpClient = getHttpClient()
      if (response.api_base) {
        httpClient.setBaseURL(response.api_base)
      }

      // Enable mTLS on clients when certificates are provided
      if (hasCertificates) {
        httpClient.enableMTLS()
        logger.info('mTLS enabled from pairing response')
      } else {
        logger.warn('Pairing response did not include certificates, keeping mTLS disabled')
      }

      logger.info('Pairing completed and configuration updated')
    } catch (error) {
      logger.error({ error }, 'Failed to complete pairing')
      throw error
    }
  }

  private updatePairingState(deviceId: string, paired: boolean): void {
    if (deviceId && deviceId !== this.deviceId) {
      const config = getConfigManager()
      config.updateConfig({
        deviceId,
      })
      this.deviceId = deviceId
    }

    const certManager = getCertificateManager()
    this.isPaired = paired && certManager.areCertificatesPresent()
  }

  private buildPairingCodeRequest(overrides: Partial<PairingCodeRequest> = {}): PairingCodeRequest {
    const display = screen.getPrimaryDisplay()
    const width = display.workAreaSize.width
    const height = display.workAreaSize.height
    const orientation = width >= height ? 'landscape' : 'portrait'

    const base: PairingCodeRequest = {
      device_label: os.hostname(),
      width,
      height,
      aspect_ratio: this.getAspectRatio(width, height),
      orientation,
      model: process.env['HEXMON_DEVICE_MODEL'] || os.type(),
      codecs: this.getSupportedCodecs(),
      device_info: {
        os: `${os.platform()} ${os.release()}`,
      },
    }

    return {
      ...base,
      ...overrides,
      device_info: {
        ...base.device_info,
        ...overrides.device_info,
      },
    }
  }

  private getSupportedCodecs(): string[] {
    const value = process.env['HEXMON_DEVICE_CODECS']
    if (!value) {
      return ['h264']
    }

    return value
      .split(',')
      .map((codec) => codec.trim())
      .filter((codec) => codec.length > 0)
  }

  private getAspectRatio(width: number, height: number): string {
    const divisor = this.getGreatestCommonDivisor(width, height)
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`
  }

  getLastPairingCode(): string | undefined {
    return this.lastPairingCode
  }

  getPairingExpiry(): string | undefined {
    return this.pairingExpiresAt
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

  /**
   * Run network diagnostics
   */
  async runDiagnostics(): Promise<NetworkDiagnostics> {
    logger.info('Running network diagnostics')

    const diagnostics: NetworkDiagnostics = {
      hostname: os.hostname(),
      ipAddresses: this.getIPAddresses(),
      dnsResolution: false,
      apiReachable: false,
      wsReachable: false,
    }

    try {
      // Test DNS resolution
      const config = getConfigManager().getConfig()
      const apiUrl = new URL(config.apiBase)
      const dns = await import('dns')
      await new Promise<void>((resolve, reject) => {
        dns.resolve4(apiUrl.hostname, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      diagnostics.dnsResolution = true
      logger.debug('DNS resolution successful')
    } catch (error) {
      logger.warn({ error }, 'DNS resolution failed')
    }

    try {
      // Test API reachability
      const httpClient = getHttpClient()
      const startTime = Date.now()
      const isReachable = await httpClient.checkConnectivity()
      diagnostics.apiReachable = isReachable
      diagnostics.latency = Date.now() - startTime
      logger.debug({ latency: diagnostics.latency }, 'API reachability test completed')
    } catch (error) {
      logger.warn({ error }, 'API reachability test failed')
    }

    diagnostics.wsReachable = false

    logger.info({ diagnostics }, 'Network diagnostics completed')
    return diagnostics
  }

  /**
   * Get IP addresses
   */
  private getIPAddresses(): string[] {
    const interfaces = os.networkInterfaces()
    const addresses: string[] = []

    for (const name of Object.keys(interfaces)) {
      const iface = interfaces[name]
      if (!iface) continue

      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          addresses.push(addr.address)
        }
      }
    }

    return addresses
  }

  /**
   * Unpair device (for testing)
   */
  async unpair(): Promise<void> {
    logger.warn('Unpairing device')

    try {
      // Delete certificates
      const certManager = getCertificateManager()
      await certManager.deleteCertificates()

      // Clear device ID from config
      const config = getConfigManager()
      config.updateConfig({
        deviceId: '',
        mtls: {
          ...config.getConfig().mtls,
          enabled: false,
        },
      })

      // Update internal state
      this.deviceId = undefined
      this.isPaired = false

      // Disable mTLS on clients
      const httpClient = getHttpClient()
      httpClient.disableMTLS()

      logger.info('Device unpaired successfully')
    } catch (error) {
      logger.error({ error }, 'Failed to unpair device')
      throw error
    }
  }

  /**
   * Check certificate renewal
   */
  async checkCertificateRenewal(): Promise<void> {
    if (!this.isPaired) {
      return
    }

    const config = getConfigManager().getConfig()
    if (!config.mtls.autoRenew) {
      return
    }

    const certManager = getCertificateManager()
    const needsRenewal = await certManager.needsRenewal()

    if (needsRenewal) {
      logger.info('Certificate renewal needed')
      // TODO: Implement certificate renewal flow
      // This would involve generating a new CSR and submitting to backend
    }
  }
}

// Singleton instance
let pairingService: PairingService | null = null

export function getPairingService(): PairingService {
  if (!pairingService) {
    pairingService = new PairingService()
  }
  return pairingService
}
