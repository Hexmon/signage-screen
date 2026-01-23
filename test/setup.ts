/**
 * Test setup and global configuration
 * Runs before all tests
 */

import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'

// Set test environment
process.env.NODE_ENV = 'test'
const baseDir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url))
process.env.HEXMON_CONFIG_PATH = path.join(baseDir, 'fixtures', 'test-config.json')

// Create test directories
const testDirs = [
  path.join(baseDir, 'fixtures'),
  path.join(baseDir, 'fixtures', 'cache'),
  path.join(baseDir, 'fixtures', 'certs'),
  path.join(baseDir, 'fixtures', 'logs'),
]

for (const dir of testDirs) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// Suppress console output during tests (optional)
if (process.env.SUPPRESS_LOGS === 'true') {
  console.log = () => {}
  console.info = () => {}
  console.warn = () => {}
  console.error = () => {}
}

// Global test timeout
const DEFAULT_TIMEOUT = 5000
if (typeof global.setTimeout !== 'undefined') {
  ;(global as any).testTimeout = DEFAULT_TIMEOUT
}
