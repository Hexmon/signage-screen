/**
 * Pairing Service - Device pairing with CSR generation
 * Handles the complete pairing flow including certificate generation and storage
 */

import * as os from 'os'
import { app } from 'electron'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { DeviceInfo, PairingRequest, PairingResponse } from '../../common/types'
import { getCertificateManager } from './cert-manager'
import { getHttpClient } from './network/http-client'
import { getWebSocketClient } from './network/websocket-client'

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

  constructor() {
    this.loadPairingStatus()
  }

  /**
   * Load pairing status from config
   */
  private loadPairingStatus(): void {
    const config = getConfigManager().getConfig()
    this.deviceId = config.deviceId
    this.isPaired = !!this.deviceId && this.deviceId.length > 0

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
      const csr = await certManager.generateCSR(deviceInfo)

      // Prepare pairing request
      const request: PairingRequest = {
        pairing_code: pairingCode,
        csr,
        device_info: deviceInfo,
      }

      // Submit to backend
      const httpClient = getHttpClient()
      const response = await httpClient.post<PairingResponse>('/v1/device-pairing/complete', request)

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
        const wsClient = getWebSocketClient()
        wsClient.enableMTLS()
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

    try {
      // Test WebSocket reachability
      const wsClient = getWebSocketClient()
      diagnostics.wsReachable = wsClient.isConnected()
      logger.debug({ wsReachable: diagnostics.wsReachable }, 'WebSocket reachability test completed')
    } catch (error) {
      logger.warn({ error }, 'WebSocket reachability test failed')
    }

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
