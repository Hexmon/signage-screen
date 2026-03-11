const { expect } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const path = require('path')
const { createTempDir, cleanupTempDir, createMockCertificate } = require('../helpers/test-utils.ts')

describe('Pairing Flow Integration', () => {
  let tempDir: string
  let certDir: string
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    tempDir = createTempDir('pairing-test-')
    certDir = path.join(tempDir, 'certs')
    fs.mkdirSync(certDir, { recursive: true })

    process.env.HEXMON_CONFIG_PATH = path.join(tempDir, 'config.json')
    fs.writeFileSync(
      process.env.HEXMON_CONFIG_PATH,
      JSON.stringify(
        {
          apiBase: 'https://api-test.hexmon.com',
          wsUrl: 'wss://api-test.hexmon.com/ws',
          deviceId: '',
          mtls: {
            enabled: false,
            certPath: path.join(certDir, 'client.crt'),
            keyPath: path.join(certDir, 'client.key'),
            caPath: path.join(certDir, 'ca.crt'),
          },
          cache: {
            path: path.join(tempDir, 'cache'),
            maxBytes: 1073741824,
          },
          intervals: {
            heartbeatMs: 300000,
            commandPollMs: 30000,
            schedulePollMs: 300000,
            defaultMediaPollMs: 300000,
            healthCheckMs: 60000,
            screenshotMs: 300000,
          },
        },
        null,
        2
      )
    )
  })

  afterEach(() => {
    sandbox.restore()
    cleanupTempDir(tempDir)
    delete process.env.HEXMON_CONFIG_PATH

    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/main/services') || key.includes('src/common')) {
        delete require.cache[key]
      }
    })
  })

  it('should complete pairing flow and clear stale pairing metadata after success', async () => {
    const { getCertificateManager } = require('../../src/main/services/cert-manager')
    const { getDeviceStateStore } = require('../../src/main/services/device-state-store')
    const { getPairingService } = require('../../src/main/services/pairing-service')
    const { getHttpClient } = require('../../src/main/services/network/http-client')

    const certManager = getCertificateManager()
    const stateStore = getDeviceStateStore()
    const pairingService = getPairingService()
    const httpClient = getHttpClient()

    await stateStore.update({
      deviceId: 'test-device-123',
      pairingCode: 'ABC123',
      pairingExpiresAt: new Date(Date.now() + 60000).toISOString(),
    })

    const csr = await certManager.generateCSR({
      deviceId: 'test-device-123',
      hostname: 'test-device',
      platform: 'linux',
      arch: 'x64',
      appVersion: '1.0.0',
      electronVersion: '1.0.0',
      nodeVersion: '1.0.0',
    })

    expect(csr).to.include('BEGIN CERTIFICATE REQUEST')

    const mockCert = createMockCertificate()
    sandbox.stub(certManager, 'verifyCertificate').resolves(true)
    sandbox.stub(httpClient, 'post').resolves({
      device_id: 'test-device-123',
      certificate: mockCert.cert,
      ca_certificate: mockCert.cert,
      fingerprint: 'fingerprint-123',
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    })

    const result = await pairingService.submitPairing('ABC123')
    const persisted = stateStore.getState()

    expect(result.device_id).to.equal('test-device-123')
    expect(persisted.deviceId).to.equal('test-device-123')
    expect(persisted.fingerprint).to.equal('fingerprint-123')
    expect(persisted.pairingCode).to.equal(undefined)
    expect(persisted.pairingExpiresAt).to.equal(undefined)
    expect(fs.existsSync(path.join(certDir, 'client.key'))).to.equal(true)
    expect(fs.existsSync(path.join(certDir, 'client.crt'))).to.equal(true)
    expect(fs.existsSync(path.join(certDir, 'ca.crt'))).to.equal(true)
  })

  it('should expose header mapping from persisted credential metadata', async () => {
    const { getDeviceStateStore } = require('../../src/main/services/device-state-store')
    const { getPairingService } = require('../../src/main/services/pairing-service')

    await getDeviceStateStore().update({
      deviceId: 'test-device-123',
      fingerprint: 'fingerprint-xyz',
    })

    const pairingService = getPairingService()
    expect(pairingService.getDeviceAuthHeaderValue()).to.equal('fingerprint-xyz')
  })

  it('should classify missing pairing material as recovery-required identity damage', async () => {
    const { getDeviceStateStore } = require('../../src/main/services/device-state-store')
    const { getPairingService } = require('../../src/main/services/pairing-service')

    await getDeviceStateStore().update({
      deviceId: 'test-device-123',
      fingerprint: 'fingerprint-xyz',
    })

    const pairingService = getPairingService()
    const identity = pairingService.getStoredIdentityHealth()

    expect(identity.health).to.equal('partial')
    expect(identity.issues.join(' ')).to.include('certificate')
  })
})
