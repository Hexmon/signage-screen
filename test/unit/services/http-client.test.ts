const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { createTempDir, cleanupTempDir } = require('../../helpers/test-utils.ts')

describe('HTTP Client', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = createTempDir('http-client-test-')

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
            certPath: path.join(tempDir, 'client.crt'),
            keyPath: path.join(tempDir, 'client.key'),
            caPath: path.join(tempDir, 'ca.crt'),
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

  it('should send device identity headers on device endpoints', async () => {
    const { getHttpClient } = require('../../../src/main/services/network/http-client')
    const { getDeviceStateStore } = require('../../../src/main/services/device-state-store')
    const { getCertificateManager } = require('../../../src/main/services/cert-manager')

    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const certManager = getCertificateManager()
    const paths = certManager.getCertificatePaths()
    fs.writeFileSync(paths.key, privateKey)

    await getDeviceStateStore().update({
      deviceId: 'device-1',
      fingerprint: 'fingerprint-123',
    })

    const httpClient = getHttpClient()
    const client = httpClient.getAxiosInstance()
    client.defaults.adapter = async (config: any) => {
      expect(config.headers['x-device-serial']).to.equal('fingerprint-123')
      expect(config.headers['x-device-auth-version']).to.equal('v1')
      expect(config.headers['x-device-timestamp']).to.be.a('string')
      expect(config.headers['x-device-signature']).to.be.a('string')
      expect(config.url).to.equal('/api/v1/device/screenshot')
      return {
        data: {
          success: true,
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      }
    }

    const response = await httpClient.post('/api/v1/device/screenshot', {
      device_id: 'device-1',
      timestamp: new Date().toISOString(),
      image_data: 'abc',
    })

    expect(response.success).to.equal(true)
  })
})
