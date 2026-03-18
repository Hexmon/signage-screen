const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const { createTempDir, cleanupTempDir } = require('../helpers/test-utils.ts')

describe('Runtime mode configuration integration', () => {
  let tempDir: string
  let configPath: string
  let originalNodeEnv: string | undefined
  let originalRuntimeMode: string | undefined
  let originalConfigPath: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
    originalRuntimeMode = process.env.HEXMON_RUNTIME_MODE
    originalConfigPath = process.env.HEXMON_CONFIG_PATH
    tempDir = createTempDir('runtime-mode-integration-')
    configPath = path.join(tempDir, 'config.json')
    process.env.HEXMON_CONFIG_PATH = configPath
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
    if (originalConfigPath === undefined) {
      delete process.env.HEXMON_CONFIG_PATH
    } else {
      process.env.HEXMON_CONFIG_PATH = originalConfigPath
    }
    if (originalRuntimeMode === undefined) {
      delete process.env.HEXMON_RUNTIME_MODE
    } else {
      process.env.HEXMON_RUNTIME_MODE = originalRuntimeMode
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }

    Object.keys(require.cache).forEach((key) => {
      if (key.includes('src/common') || key.includes('src/main/runtime-mode')) {
        delete require.cache[key]
      }
    })
  })

  it('should persist qa mode from config and resolve kiosk policy from it', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          apiBase: 'https://api-test.hexmon.com',
          wsUrl: 'wss://api-test.hexmon.com/ws',
          deviceId: '',
          runtime: { mode: 'qa' },
        },
        null,
        2
      )
    )

    const { getConfigManager } = require('../../src/common/config')
    const { getRuntimeMode, getRuntimeWindowPolicy } = require('../../src/main/runtime-mode')

    const config = getConfigManager().getConfig()
    const policy = getRuntimeWindowPolicy(getRuntimeMode(config))

    expect(config.runtime.mode).to.equal('qa')
    expect(policy.kiosk).to.equal(true)
    expect(policy.disableInput).to.equal(true)
  })

  it('should default development runs to dev mode when runtime is not configured', () => {
    process.env.NODE_ENV = 'development'
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          apiBase: 'https://api-test.hexmon.com',
          wsUrl: 'wss://api-test.hexmon.com/ws',
          deviceId: '',
        },
        null,
        2
      )
    )

    const { getConfigManager } = require('../../src/common/config')
    const { getRuntimeMode, getRuntimeWindowPolicy } = require('../../src/main/runtime-mode')

    const config = getConfigManager().getConfig()
    const policy = getRuntimeWindowPolicy(getRuntimeMode(config))

    expect(config.runtime.mode).to.equal('dev')
    expect(policy.kiosk).to.equal(false)
    expect(policy.disableInput).to.equal(false)
  })
})
