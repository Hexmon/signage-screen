const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const {
  createTempDir,
  cleanupTempDir,
  issueSignedCertificateFromCsr,
} = require('../../helpers/test-utils.ts')

describe('Certificate Manager', () => {
  let tempDir
  let certDir

  function writeConfig(strictCertificateValidation) {
    process.env.HEXMON_CONFIG_PATH = path.join(tempDir, 'config.json')
    fs.writeFileSync(
      process.env.HEXMON_CONFIG_PATH,
      JSON.stringify(
        {
          apiBase: 'https://api-test.hexmon.com',
          wsUrl: 'wss://api-test.hexmon.com/ws',
          deviceId: 'device-1',
          mtls: {
            enabled: false,
            certPath: path.join(certDir, 'client.crt'),
            keyPath: path.join(certDir, 'client.key'),
            caPath: path.join(certDir, 'ca.crt'),
            strictCertificateValidation,
          },
          cache: {
            path: path.join(tempDir, 'cache'),
            maxBytes: 10485760,
          },
          intervals: {
            heartbeatMs: 30000,
            commandPollMs: 30000,
            schedulePollMs: 60000,
            defaultMediaPollMs: 60000,
            healthCheckMs: 60000,
            screenshotMs: 300000,
          },
        },
        null,
        2
      )
    )
  }

  beforeEach(() => {
    tempDir = createTempDir('cert-manager-test-')
    certDir = path.join(tempDir, 'certs')
    fs.mkdirSync(certDir, { recursive: true })
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
    delete process.env.HEXMON_CONFIG_PATH

    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/main/services') || key.includes('src/common')) {
        delete require.cache[key]
      }
    })
  })

  it('accepts compatibility certificates when strict validation is disabled', async () => {
    writeConfig(false)
    const { getCertificateManager } = require('../../../src/main/services/cert-manager')
    const { getPlayerMetrics } = require('../../../src/main/services/telemetry/player-metrics')

    const certManager = getCertificateManager()
    await certManager.storeCertificate(
      '-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----',
      '-----BEGIN CERTIFICATE-----\nYmFy\n-----END CERTIFICATE-----'
    )

    const metadata = certManager.getCertificateMetadata()
    const metrics = await getPlayerMetrics().renderPrometheusMetrics(async () => ({
      cpuUsage: 0,
      cpuCores: 1,
      cpuLoad1m: 0,
      cpuLoad5m: 0,
      cpuLoad15m: 0,
      memoryUsage: 0,
      memoryTotal: 1,
      memoryFree: 1,
      diskUsage: 0,
      diskTotal: 1,
      diskFree: 1,
      uptime: 0,
      networkInterfaces: [],
      displayCount: 0,
      displays: [],
      hostname: 'test-host',
      osVersion: 'test-os',
    }))
    expect(metadata).to.not.equal(null)
    expect(metadata.verificationMode).to.equal('compatibility')
    expect(fs.existsSync(path.join(certDir, 'client.crt'))).to.equal(true)
    expect(fs.existsSync(path.join(certDir, 'ca.crt'))).to.equal(true)
    expect(metrics).to.contain('signhex_player_certificate_validation_total{result="compatibility_accepted"} 1')
  })

  it('accepts a CA-signed certificate in strict validation mode', async () => {
    writeConfig(true)
    const { getCertificateManager } = require('../../../src/main/services/cert-manager')
    const { getPlayerMetrics } = require('../../../src/main/services/telemetry/player-metrics')

    const certManager = getCertificateManager()
    const csr = await certManager.generateCSR({
      deviceId: 'device-1',
      hostname: 'test-host',
      platform: 'linux',
      arch: 'x64',
      appVersion: '1.0.0',
      electronVersion: '1.0.0',
      nodeVersion: process.version,
    })

    const issued = issueSignedCertificateFromCsr(csr)
    await certManager.storeCertificate(issued.certPem, issued.caCertPem)

    const metadata = certManager.getCertificateMetadata()
    expect(metadata).to.not.equal(null)
    expect(metadata.verificationMode).to.equal('x509')
    expect(fs.existsSync(path.join(certDir, 'client.crt'))).to.equal(true)
    expect(fs.existsSync(path.join(certDir, 'ca.crt'))).to.equal(true)

    const metrics = await getPlayerMetrics().renderPrometheusMetrics(async () => ({
      cpuUsage: 0,
      cpuCores: 1,
      cpuLoad1m: 0,
      cpuLoad5m: 0,
      cpuLoad15m: 0,
      memoryUsage: 0,
      memoryTotal: 1,
      memoryFree: 1,
      diskUsage: 0,
      diskTotal: 1,
      diskFree: 1,
      uptime: 0,
      networkInterfaces: [],
      displayCount: 0,
      displays: [],
      hostname: 'test-host',
      osVersion: 'test-os',
    }))
    expect(metrics).to.contain('signhex_player_certificate_validation_total{result="x509_valid"} 1')
  })

  it('rejects compatibility certificates in strict validation mode and preserves the private key', async () => {
    writeConfig(true)
    const { getCertificateManager } = require('../../../src/main/services/cert-manager')
    const { getPlayerMetrics } = require('../../../src/main/services/telemetry/player-metrics')

    const certManager = getCertificateManager()
    await certManager.generateCSR({
      deviceId: 'device-1',
      hostname: 'test-host',
      platform: 'linux',
      arch: 'x64',
      appVersion: '1.0.0',
      electronVersion: '1.0.0',
      nodeVersion: process.version,
    })

    let thrownError = null
    try {
      await certManager.storeCertificate(
        '-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----',
        '-----BEGIN CERTIFICATE-----\nYmFy\n-----END CERTIFICATE-----'
      )
    } catch (error) {
      thrownError = error
    }

    expect(thrownError).to.be.instanceOf(Error)
    expect(String(thrownError.message)).to.include('Strict certificate validation failed')
    expect(fs.existsSync(path.join(certDir, 'client.key'))).to.equal(true)
    expect(fs.existsSync(path.join(certDir, 'client.crt'))).to.equal(false)
    expect(fs.existsSync(path.join(certDir, 'ca.crt'))).to.equal(false)
    expect(fs.existsSync(path.join(certDir, 'cert-meta.json'))).to.equal(false)

    const metrics = await getPlayerMetrics().renderPrometheusMetrics(async () => ({
      cpuUsage: 0,
      cpuCores: 1,
      cpuLoad1m: 0,
      cpuLoad5m: 0,
      cpuLoad15m: 0,
      memoryUsage: 0,
      memoryTotal: 1,
      memoryFree: 1,
      diskUsage: 0,
      diskTotal: 1,
      diskFree: 1,
      uptime: 0,
      networkInterfaces: [],
      displayCount: 0,
      displays: [],
      hostname: 'test-host',
      osVersion: 'test-os',
    }))
    expect(metrics).to.contain('signhex_player_certificate_validation_total{result="strict_rejected"} 1')
  })
})
