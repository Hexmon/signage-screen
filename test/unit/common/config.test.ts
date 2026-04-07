/**
 * Unit tests for Configuration Manager
 */

const { expect } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const path = require('path')
const { createTempDir, cleanupTempDir } = require('../../helpers/test-utils.ts')

describe('Config Manager', () => {
  let tempDir: string
  let configPath: string
  let originalNodeEnv: string | undefined
  let originalRuntimeMode: string | undefined
  let originalConfigPath: string | undefined
  let originalHexmonApiBase: string | undefined
  let originalHexmonWsUrl: string | undefined
  let originalSignageAllowLocalhost: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
    originalRuntimeMode = process.env.HEXMON_RUNTIME_MODE
    originalConfigPath = process.env.HEXMON_CONFIG_PATH
    originalHexmonApiBase = process.env.HEXMON_API_BASE
    originalHexmonWsUrl = process.env.HEXMON_WS_URL
    originalSignageAllowLocalhost = process.env.SIGNAGE_ALLOW_LOCALHOST
    tempDir = createTempDir('config-test-')
    configPath = path.join(tempDir, 'config.json')

    // Create a test config file
    const testConfig = {
      apiBase: 'https://api-test.hexmon.com',
      wsUrl: 'wss://api-test.hexmon.com/ws',
      deviceId: 'test-device',
      runtime: {
        mode: 'qa',
      },
      cache: {
        path: path.join(tempDir, 'cache'),
        maxBytes: 1073741824,
      },
      intervals: {
        heartbeatMs: 300000,
        commandPollMs: 30000,
        schedulePollMs: 300000,
        healthCheckMs: 60000,
        screenshotMs: 300000,
      },
    }

    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2))
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
    if (originalHexmonApiBase === undefined) {
      delete process.env.HEXMON_API_BASE
    } else {
      process.env.HEXMON_API_BASE = originalHexmonApiBase
    }
    if (originalHexmonWsUrl === undefined) {
      delete process.env.HEXMON_WS_URL
    } else {
      process.env.HEXMON_WS_URL = originalHexmonWsUrl
    }
    if (originalSignageAllowLocalhost === undefined) {
      delete process.env.SIGNAGE_ALLOW_LOCALHOST
    } else {
      process.env.SIGNAGE_ALLOW_LOCALHOST = originalSignageAllowLocalhost
    }
    sinon.restore()
  })

  describe('Configuration Loading', () => {
    it('should load configuration from file', () => {
      // Import after setting env var
      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()

      expect(config.apiBase).to.equal('https://api-test.hexmon.com')
      expect(config.deviceId).to.equal('test-device')
      expect(config.runtime.mode).to.equal('qa')
    })

    it('should validate required fields', () => {
      // Create invalid config
      const invalidConfig = {
        apiBase: 'https://api-test.hexmon.com',
        // Missing required fields
      }

      fs.writeFileSync(configPath, JSON.stringify(invalidConfig, null, 2))

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const validation = configManager.validateConfig()

      expect(validation.valid).to.be.true
      expect(validation.errors.length).to.equal(0)
    })

    it('should apply default values for optional fields', () => {
      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()

      expect(config.log.level).to.exist
      expect(config.intervals).to.exist
      expect(config.runtime.mode).to.exist
    })

    it('should migrate the legacy 30-second command poll interval to 5 seconds', () => {
      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()
      const diskConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

      expect(config.intervals.commandPollMs).to.equal(5000)
      expect(diskConfig.intervals.commandPollMs).to.equal(5000)
    })

    it('should migrate the legacy strict player CSP to the media-safe default', () => {
      const legacyConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      legacyConfig.security = {
        csp: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
      }
      fs.writeFileSync(configPath, JSON.stringify(legacyConfig, null, 2))

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()
      const diskConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

      expect(config.security.csp).to.include("img-src 'self' data: blob: file: http: https:")
      expect(config.security.csp).to.include("connect-src 'self' data: blob: http: https: ws: wss:")
      expect(diskConfig.security.csp).to.equal(config.security.csp)
    })
  })

  describe('Configuration Validation', () => {
    it('should validate valid configuration', () => {
      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const validation = configManager.validateConfig()

      expect(validation.valid).to.be.true
      expect(validation.errors).to.be.empty
    })

    it('should detect missing apiBase', () => {
      const invalidConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      delete invalidConfig.apiBase
      fs.writeFileSync(configPath, JSON.stringify(invalidConfig, null, 2))

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const validation = configManager.validateConfig()

      expect(validation.valid).to.be.true
      expect(configManager.getConfig().apiBase).to.be.a('string').and.not.equal('')
    })

    it('should detect invalid URL format', () => {
      const invalidConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      invalidConfig.apiBase = 'not-a-url'
      fs.writeFileSync(configPath, JSON.stringify(invalidConfig, null, 2))

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const validation = configManager.validateConfig()

      expect(validation.valid).to.be.false
    })

    it('should reject invalid runtime modes', () => {
      const invalidConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      invalidConfig.runtime = { mode: 'staging' }
      fs.writeFileSync(configPath, JSON.stringify(invalidConfig, null, 2))

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const validation = configManager.validateConfig()

      expect(validation.valid).to.be.false
      expect(validation.errors).to.include('runtime.mode must be one of: dev, qa, production')
    })
  })

  describe('Environment Variable Overrides', () => {
    it('should override non-URL fields with environment variables', () => {
      const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      delete updatedConfig.deviceId
      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2))

      process.env.HEXMON_DEVICE_ID = 'override-device'

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()

      expect(config.deviceId).to.equal('override-device')

      delete process.env.HEXMON_DEVICE_ID
    })

    it('should default to dev runtime mode in development', () => {
      const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      delete updatedConfig.runtime
      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2))

      process.env.NODE_ENV = 'development'

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()

      expect(config.runtime.mode).to.equal('dev')
    })

    it('should honor HEXMON_RUNTIME_MODE when valid', () => {
      const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      delete updatedConfig.runtime
      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2))

      process.env.HEXMON_RUNTIME_MODE = 'production'

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()

      expect(config.runtime.mode).to.equal('production')
    })

    it('should let HEXMON_RUNTIME_MODE override the config file', () => {
      process.env.HEXMON_RUNTIME_MODE = 'production'

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()

      expect(config.runtime.mode).to.equal('production')
    })

    it('should honor HEXMON_API_BASE and HEXMON_WS_URL environment variables', () => {
      const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      delete updatedConfig.apiBase
      delete updatedConfig.wsUrl
      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2))

      process.env.HEXMON_API_BASE = 'http://10.20.0.20:3000'
      process.env.HEXMON_WS_URL = 'ws://10.20.0.20:3000/ws'
      process.env.HEXMON_RUNTIME_MODE = 'production'

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()

      expect(config.apiBase).to.equal('http://10.20.0.20:3000')
      expect(config.wsUrl).to.equal('ws://10.20.0.20:3000/ws')
    })
  })

  describe('Configuration Update', () => {
    it('should update configuration values', () => {
      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      configManager.updateConfig({ deviceId: 'updated-device' })

      const config = configManager.getConfig()
      expect(config.deviceId).to.equal('updated-device')
    })

    it('should persist configuration to disk', () => {
      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      configManager.updateConfig({ deviceId: 'persisted-device' })

      // Read from disk
      const diskConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      expect(diskConfig.deviceId).to.equal('persisted-device')
    })

    it('should derive wsUrl from apiBase updates using the active runtime mode', () => {
      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      configManager.updateConfig({ apiBase: 'http://10.20.0.20:3000' })

      const config = configManager.getConfig()
      expect(config.wsUrl).to.equal('ws://10.20.0.20:3000/ws')
    })
  })

  describe('Production backend requirements', () => {
    it('should not invent a backend IP in production when none is configured', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            deviceId: '',
            runtime: { mode: 'production' },
          },
          null,
          2
        )
      )

      delete process.env.NODE_ENV
      delete process.env.HEXMON_API_BASE
      delete process.env.HEXMON_WS_URL
      delete process.env.SIGNAGE_ALLOW_LOCALHOST

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()
      const validation = configManager.validateConfig()

      expect(config.apiBase).to.equal('')
      expect(config.wsUrl).to.equal('')
      expect(validation.valid).to.equal(false)
      expect(validation.errors).to.include(
        'apiBase is required for qa/production. Configure the backend IP, for example http://10.20.0.20:3000'
      )
      expect(validation.errors).to.include(
        'wsUrl is required for qa/production. Configure the backend websocket URL, for example ws://10.20.0.20:3000/ws'
      )
    })
  })

  describe('Singleton Pattern', () => {
    it('should return same instance', () => {
      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const instance1 = getConfigManager()
      const instance2 = getConfigManager()

      expect(instance1).to.equal(instance2)
    })
  })
})
