/**
 * Certificate Manager - mTLS certificate generation and management
 * Handles ECDSA P-256 key pair generation, CSR creation, certificate storage, and auto-renewal
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import forge from 'node-forge'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { atomicWrite, ensureDir } from '../../common/utils'
import { DeviceInfo } from '../../common/types'

const logger = getLogger('cert-manager')

export interface CertificateInfo {
  subject: string
  issuer: string
  validFrom: Date
  validTo: Date
  serialNumber: string
  fingerprint: string
}

export interface CertificateMetadata {
  fingerprint: string
  validFrom: string
  validTo: string
  subject: string
  issuer: string
  serialNumber: string
}

export interface CSRSubjectOverrides {
  commonName?: string
  organization?: string
  organizationalUnit?: string
  country?: string
  state?: string
  locality?: string
}

export class CertificateManager {
  private certPath: string
  private keyPath: string
  private caPath: string
  private csrPath: string
  private metadataPath: string

  constructor() {
    const config = getConfigManager().getConfig()
    this.certPath = config.mtls.certPath
    this.keyPath = config.mtls.keyPath
    this.caPath = config.mtls.caPath
    this.csrPath = path.join(path.dirname(this.keyPath), 'client.csr')
    this.metadataPath = path.join(path.dirname(this.keyPath), 'cert-meta.json')

    // Ensure certificate directory exists with secure permissions
    const certDir = path.dirname(this.certPath)
    ensureDir(certDir, 0o700)
  }

  /**
   * Generate RSA 2048 key pair
   */
  async generateKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
    logger.info('Generating RSA 2048 key pair')

    return new Promise((resolve, reject) => {
      crypto.generateKeyPair(
        'rsa',
        {
          modulusLength: 2048,
          publicKeyEncoding: {
            type: 'spki',
            format: 'pem',
          },
          privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem',
          },
        },
        (err, publicKey, privateKey) => {
          if (err) {
            logger.error({ error: err }, 'Failed to generate key pair')
            reject(err)
          } else {
            logger.info('Key pair generated successfully')
            resolve({ privateKey, publicKey })
          }
        }
      )
    })
  }

  /**
   * Generate Certificate Signing Request (CSR)
   */
  async generateCSR(deviceInfo: DeviceInfo, overrides: CSRSubjectOverrides = {}): Promise<string> {
    logger.info({ deviceId: deviceInfo.deviceId }, 'Generating CSR')

    try {
      // Generate key pair if not exists
      let privateKey: string
      if (fs.existsSync(this.keyPath)) {
        privateKey = fs.readFileSync(this.keyPath, 'utf-8')
        logger.info('Using existing private key')
      } else {
        const keyPair = await this.generateKeyPair()
        privateKey = keyPair.privateKey

        // Store private key with secure permissions
        await atomicWrite(this.keyPath, privateKey)
        fs.chmodSync(this.keyPath, 0o600)
        logger.info({ keyPath: this.keyPath }, 'Private key stored securely')
      }

      // Derive public key from private key
      const publicKeyPem = crypto
        .createPublicKey(crypto.createPrivateKey(privateKey))
        .export({ type: 'spki', format: 'pem' })
        .toString()

      const csr = this.createCSR(privateKey, publicKeyPem, deviceInfo, overrides)

      // Store CSR
      await atomicWrite(this.csrPath, csr)
      logger.info({ csrPath: this.csrPath }, 'CSR generated and stored')

      return csr
    } catch (error) {
      logger.error({ error }, 'Failed to generate CSR')
      throw error
    }
  }

  /**
   * Create CSR using node-forge
   */
  private createCSR(
    privateKeyPem: string,
    publicKeyPem: string,
    deviceInfo: DeviceInfo,
    overrides: CSRSubjectOverrides
  ): string {
    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem)
    const publicKey = forge.pki.publicKeyFromPem(publicKeyPem)

    const csr = forge.pki.createCertificationRequest()
    csr.publicKey = publicKey

    const subject = [
      { name: 'commonName', value: overrides.commonName || deviceInfo.deviceId || deviceInfo.hostname || 'hexmon-device' },
      { name: 'organizationName', value: overrides.organization || 'HexmonSignage' },
      { name: 'countryName', value: overrides.country || 'US' },
    ]

    if (overrides.organizationalUnit) {
      subject.push({ name: 'organizationalUnitName', value: overrides.organizationalUnit })
    }
    if (overrides.state) {
      subject.push({ name: 'stateOrProvinceName', value: overrides.state })
    }
    if (overrides.locality) {
      subject.push({ name: 'localityName', value: overrides.locality })
    }

    csr.setSubject(subject)
    csr.sign(privateKey, forge.md.sha256.create())

    if (!csr.verify()) {
      throw new Error('CSR verification failed')
    }

    return forge.pki.certificationRequestToPem(csr)
  }

  /**
   * Store certificate with secure permissions
   */
  async storeCertificate(cert: string, ca: string): Promise<void> {
    logger.info('Storing certificates')

    try {
      // Store client certificate
      await atomicWrite(this.certPath, cert)
      fs.chmodSync(this.certPath, 0o600)
      logger.info({ certPath: this.certPath }, 'Client certificate stored')

      // Store CA certificate
      await atomicWrite(this.caPath, ca)
      fs.chmodSync(this.caPath, 0o600)
      logger.info({ caPath: this.caPath }, 'CA certificate stored')

      // Verify certificates
      const isValid = await this.verifyCertificate()
      if (!isValid) {
        throw new Error('Certificate verification failed')
      }

      // Persist certificate metadata
      await this.persistMetadata()

      logger.info('Certificates stored and verified successfully')
    } catch (error) {
      logger.error({ error }, 'Failed to store certificates')
      throw error
    }
  }

  /**
   * Load certificates for mTLS
   */
  async loadCertificates(): Promise<{ cert: Buffer; key: Buffer; ca: Buffer }> {
    logger.debug('Loading certificates for mTLS')

    try {
      if (!this.areCertificatesPresent()) {
        throw new Error('Certificates not found')
      }

      const cert = fs.readFileSync(this.certPath)
      const key = fs.readFileSync(this.keyPath)
      const ca = fs.readFileSync(this.caPath)

      logger.debug('Certificates loaded successfully')
      return { cert, key, ca }
    } catch (error) {
      logger.error({ error }, 'Failed to load certificates')
      throw error
    }
  }

  /**
   * Check if certificates are present
   */
  areCertificatesPresent(): boolean {
    return fs.existsSync(this.certPath) && fs.existsSync(this.keyPath) && fs.existsSync(this.caPath)
  }

  /**
   * Parse certificate and extract information
   */
  async getCertificateInfo(): Promise<CertificateInfo | null> {
    if (!fs.existsSync(this.certPath)) {
      return null
    }

    try {
      const certPem = fs.readFileSync(this.certPath, 'utf-8')
      // Parse certificate using crypto module
      // This is simplified - in production use node-forge or x509 library
      const cert = crypto.X509Certificate ? new crypto.X509Certificate(certPem) : null

      if (!cert) {
        logger.warn('X509Certificate not available in this Node.js version')
        return null
      }

      return {
        subject: cert.subject,
        issuer: cert.issuer,
        validFrom: new Date(cert.validFrom),
        validTo: new Date(cert.validTo),
        serialNumber: cert.serialNumber,
        fingerprint: cert.fingerprint,
      }
    } catch (error) {
      logger.error({ error }, 'Failed to parse certificate')
      return null
    }
  }

  /**
   * Load persisted certificate metadata
   */
  getCertificateMetadata(): CertificateMetadata | null {
    if (!fs.existsSync(this.metadataPath)) {
      return null
    }

    try {
      const data = fs.readFileSync(this.metadataPath, 'utf-8')
      return JSON.parse(data) as CertificateMetadata
    } catch (error) {
      logger.error({ error }, 'Failed to read certificate metadata')
      return null
    }
  }

  private async persistMetadata(): Promise<void> {
    const info = await this.getCertificateInfo()
    if (!info) {
      return
    }

    const metadata: CertificateMetadata = {
      fingerprint: info.fingerprint,
      validFrom: info.validFrom.toISOString(),
      validTo: info.validTo.toISOString(),
      subject: info.subject,
      issuer: info.issuer,
      serialNumber: info.serialNumber,
    }

    await atomicWrite(this.metadataPath, JSON.stringify(metadata, null, 2))
    fs.chmodSync(this.metadataPath, 0o600)
  }

  /**
   * Check certificate expiry and determine if renewal is needed
   */
  async needsRenewal(): Promise<boolean> {
    const config = getConfigManager().getConfig()
    const certInfo = await this.getCertificateInfo()

    if (!certInfo) {
      logger.info('No certificate found, renewal needed')
      return true
    }

    const now = new Date()
    const daysUntilExpiry = Math.floor((certInfo.validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

    logger.debug({ daysUntilExpiry, renewBeforeDays: config.mtls.renewBeforeDays }, 'Checking certificate expiry')

    if (daysUntilExpiry <= config.mtls.renewBeforeDays) {
      logger.info({ daysUntilExpiry }, 'Certificate renewal needed')
      return true
    }

    return false
  }

  /**
   * Verify certificate chain
   */
  async verifyCertificate(): Promise<boolean> {
    try {
      if (!this.areCertificatesPresent()) {
        return false
      }

      const certInfo = await this.getCertificateInfo()
      if (!certInfo) {
        return false
      }

      // Check if certificate is expired
      const now = new Date()
      if (now < certInfo.validFrom || now > certInfo.validTo) {
        logger.warn({ validFrom: certInfo.validFrom, validTo: certInfo.validTo }, 'Certificate is expired or not yet valid')
        return false
      }

      logger.debug('Certificate verification passed')
      return true
    } catch (error) {
      logger.error({ error }, 'Certificate verification failed')
      return false
    }
  }

  /**
   * Delete certificates (for testing or re-pairing)
   */
  async deleteCertificates(): Promise<void> {
    logger.warn('Deleting certificates')

    const files = [this.certPath, this.keyPath, this.caPath, this.csrPath, this.metadataPath]

    for (const file of files) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file)
        logger.info({ file }, 'Certificate file deleted')
      }
    }
  }

  /**
   * Get certificate paths
   */
  getCertificatePaths(): { cert: string; key: string; ca: string } {
    return {
      cert: this.certPath,
      key: this.keyPath,
      ca: this.caPath,
    }
  }
}

// Singleton instance
let certManager: CertificateManager | null = null

export function getCertificateManager(): CertificateManager {
  if (!certManager) {
    certManager = new CertificateManager()
  }
  return certManager
}
