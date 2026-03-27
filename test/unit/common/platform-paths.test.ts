const { expect } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { createTempDir, cleanupTempDir } = require('../../helpers/test-utils.ts')

describe('platform-paths', () => {
  let tempDir
  let originalEnv = {}

  beforeEach(() => {
    tempDir = createTempDir('platform-paths-')
    originalEnv = {
      HEXMON_RUNTIME_ROOT: process.env.HEXMON_RUNTIME_ROOT,
      HEXMON_CONFIG_PATH: process.env.HEXMON_CONFIG_PATH,
      SIGNAGE_CONFIG_PATH: process.env.SIGNAGE_CONFIG_PATH,
      HEXMON_CACHE_PATH: process.env.HEXMON_CACHE_PATH,
      HEXMON_MTLS_CERT_DIR: process.env.HEXMON_MTLS_CERT_DIR,
    }
    delete process.env.HEXMON_CONFIG_PATH
    delete process.env.SIGNAGE_CONFIG_PATH
    delete process.env.HEXMON_CACHE_PATH
    delete process.env.HEXMON_MTLS_CERT_DIR
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    sinon.restore()
    delete require.cache[require.resolve('../../../src/common/platform-paths')]
  })

  it('resolves runtime paths from HEXMON_RUNTIME_ROOT', () => {
    process.env.HEXMON_RUNTIME_ROOT = tempDir
    const { resolveRuntimePaths } = require('../../../src/common/platform-paths')

    const runtimePaths = resolveRuntimePaths()

    expect(runtimePaths.runtimeRoot).to.equal(tempDir)
    expect(runtimePaths.configPath).to.equal(path.join(tempDir, 'config.json'))
    expect(runtimePaths.cachePath).to.equal(path.join(tempDir, 'cache'))
    expect(runtimePaths.certDir).to.equal(path.join(tempDir, 'certs'))
  })

  it('imports legacy Linux state into the runtime root once', () => {
    const legacyRoot = path.join(tempDir, 'legacy')
    const runtimeRoot = path.join(tempDir, 'runtime')
    const legacyCache = path.join(legacyRoot, 'cache')
    const legacyCerts = path.join(legacyRoot, 'certs')
    const legacyConfig = path.join(legacyRoot, 'config.json')

    fs.mkdirSync(legacyCache, { recursive: true })
    fs.mkdirSync(legacyCerts, { recursive: true })
    fs.writeFileSync(path.join(legacyCache, 'cached.txt'), 'cached-data')
    fs.writeFileSync(path.join(legacyCerts, 'client.crt'), 'crt-data')
    fs.writeFileSync(
      legacyConfig,
      JSON.stringify(
        {
          cache: { path: legacyCache },
          mtls: {
            certPath: path.join(legacyCerts, 'client.crt'),
            keyPath: path.join(legacyCerts, 'client.key'),
            caPath: path.join(legacyCerts, 'ca.crt'),
          },
        },
        null,
        2
      )
    )

    process.env.HEXMON_RUNTIME_ROOT = runtimeRoot
    sinon.stub(os, 'platform').returns('linux')
    const { resolveRuntimePaths, importLegacyLinuxRuntimeState } = require('../../../src/common/platform-paths')
    const runtimePaths = resolveRuntimePaths()
    runtimePaths.legacyLinux = {
      configPath: legacyConfig,
      cachePath: legacyCache,
      certDir: legacyCerts,
    }

    const result = importLegacyLinuxRuntimeState(runtimePaths)

    expect(result.imported).to.equal(true)
    expect(fs.existsSync(path.join(runtimeRoot, 'config.json'))).to.equal(true)
    expect(fs.existsSync(path.join(runtimeRoot, 'cache', 'cached.txt'))).to.equal(true)
    expect(fs.existsSync(path.join(runtimeRoot, 'certs', 'client.crt'))).to.equal(true)

    const migratedConfig = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'config.json'), 'utf-8'))
    expect(migratedConfig.cache.path).to.equal(path.join(runtimeRoot, 'cache'))
    expect(migratedConfig.mtls.certPath).to.equal(path.join(runtimeRoot, 'certs', 'client.crt'))
  })
})
