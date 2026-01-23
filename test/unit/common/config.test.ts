/**
 * Unit tests for Configuration Manager
 */

import { expect } from 'chai'
import * as sinon from 'sinon'
import * as fs from 'fs'
import * as path from 'path'
import { createTempDir, cleanupTempDir } from '../../helpers/test-utils'

describe('Config Manager', () => {
  let tempDir: string
  let configPath: string

  beforeEach(() => {
    tempDir = createTempDir('config-test-')
    configPath = path.join(tempDir, 'config.json')

    // Create a test config file
    const testConfig = {
      apiBase: 'https://api-test.hexmon.com',
      wsUrl: 'wss://api-test.hexmon.com/ws',
      deviceId: 'test-device',
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
    delete process.env.HEXMON_CONFIG_PATH
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

      expect(validation.valid).to.be.false
      expect(validation.errors.length).to.be.greaterThan(0)
    })

    it('should apply default values for optional fields', () => {
      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()

      expect(config.log.level).to.exist
      expect(config.intervals).to.exist
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

      expect(validation.valid).to.be.false
      expect(validation.errors.some((e: string) => e.includes('apiBase'))).to.be.true
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
  })

  describe('Environment Variable Override', () => {
    it('should override config with environment variables', () => {
      process.env.HEXMON_API_BASE = 'https://override.hexmon.com'
      process.env.HEXMON_DEVICE_ID = 'override-device'

      delete require.cache[require.resolve('../../../src/common/config')]
      const { getConfigManager } = require('../../../src/common/config')

      const configManager = getConfigManager()
      const config = configManager.getConfig()

      expect(config.apiBase).to.equal('https://override.hexmon.com')
      expect(config.deviceId).to.equal('override-device')

      delete process.env.HEXMON_API_BASE
      delete process.env.HEXMON_DEVICE_ID
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
