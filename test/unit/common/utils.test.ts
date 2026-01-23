/**
 * Unit tests for common utilities
 */

import { expect } from 'chai'
import * as sinon from 'sinon'
import * as fs from 'fs'
import * as path from 'path'
import { createTempDir, cleanupTempDir, createTestFile, calculateHash } from '../../helpers/test-utils.ts'

// Import functions to test
import {
  hashFile,
  atomicWrite,
  ensureDir,
  retryWithBackoff,
  sanitizePath,
  parseTimeString,
} from '../../../src/common/utils.ts'

describe('Common Utils', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = createTempDir('utils-test-')
  })

  afterEach(() => {
    cleanupTempDir(tempDir)
    sinon.restore()
  })

  describe('hashFile', () => {
    it('should calculate SHA-256 hash of file', async () => {
      const filePath = path.join(tempDir, 'test.txt')
      const content = Buffer.from('test content')
      fs.writeFileSync(filePath, content)

      const expectedHash = calculateHash(content)
      const actualHash = await hashFile(filePath)

      expect(actualHash).to.equal(expectedHash)
    })

    it('should throw error for non-existent file', async () => {
      const filePath = path.join(tempDir, 'nonexistent.txt')

      try {
        await hashFile(filePath)
        expect.fail('Should have thrown error')
      } catch (error) {
        expect(error).to.be.instanceOf(Error)
      }
    })
  })

  describe('atomicWrite', () => {
    it('should write file atomically', async () => {
      const filePath = path.join(tempDir, 'atomic.txt')
      const content = Buffer.from('atomic content')

      await atomicWrite(filePath, content)

      expect(fs.existsSync(filePath)).to.be.true
      const readContent = fs.readFileSync(filePath)
      expect(readContent.toString()).to.equal(content.toString())
    })

    it('should overwrite existing file', async () => {
      const filePath = path.join(tempDir, 'overwrite.txt')
      fs.writeFileSync(filePath, 'old content')

      const newContent = Buffer.from('new content')
      await atomicWrite(filePath, newContent)

      const readContent = fs.readFileSync(filePath)
      expect(readContent.toString()).to.equal(newContent.toString())
    })

    it('should create parent directories if needed', async () => {
      const filePath = path.join(tempDir, 'subdir', 'nested', 'file.txt')
      const content = Buffer.from('nested content')

      await atomicWrite(filePath, content)

      expect(fs.existsSync(filePath)).to.be.true
    })
  })

  describe('ensureDir', () => {
    it('should create directory if it does not exist', () => {
      const dirPath = path.join(tempDir, 'newdir')

      ensureDir(dirPath, 0o755)

      expect(fs.existsSync(dirPath)).to.be.true
      expect(fs.statSync(dirPath).isDirectory()).to.be.true
    })

    it('should not throw if directory already exists', () => {
      const dirPath = path.join(tempDir, 'existingdir')
      fs.mkdirSync(dirPath)

      expect(() => ensureDir(dirPath, 0o755)).to.not.throw()
    })

    it('should create nested directories', () => {
      const dirPath = path.join(tempDir, 'nested', 'deep', 'dir')

      ensureDir(dirPath, 0o755)

      expect(fs.existsSync(dirPath)).to.be.true
    })
  })

  describe('retryWithBackoff', () => {
    it('should succeed on first try', async () => {
      const fn = sinon.stub().resolves('success')

      const result = await retryWithBackoff(fn, 3, 100)

      expect(result).to.equal('success')
      expect(fn.callCount).to.equal(1)
    })

    it('should retry on failure and eventually succeed', async () => {
      const fn = sinon.stub()
      fn.onCall(0).rejects(new Error('fail 1'))
      fn.onCall(1).rejects(new Error('fail 2'))
      fn.onCall(2).resolves('success')

      const result = await retryWithBackoff(fn, 3, 10)

      expect(result).to.equal('success')
      expect(fn.callCount).to.equal(3)
    })

    it('should throw after max retries', async () => {
      const fn = sinon.stub().rejects(new Error('always fails'))

      try {
        await retryWithBackoff(fn, 3, 10)
        expect.fail('Should have thrown error')
      } catch (error: any) {
        expect(error.message).to.equal('always fails')
        expect(fn.callCount).to.equal(3)
      }
    })

    it('should apply exponential backoff', async () => {
      const fn = sinon.stub()
      fn.onCall(0).rejects(new Error('fail 1'))
      fn.onCall(1).rejects(new Error('fail 2'))
      fn.onCall(2).resolves('success')

      const startTime = Date.now()
      await retryWithBackoff(fn, 3, 50)
      const elapsed = Date.now() - startTime

      // Should have waited at least 50ms + 100ms = 150ms
      expect(elapsed).to.be.at.least(100)
    })
  })

  describe('sanitizePath', () => {
    it('should remove directory traversal attempts', () => {
      const malicious = '../../../etc/passwd'
      const sanitized = sanitizePath(malicious)

      expect(sanitized).to.not.include('..')
    })

    it('should remove null bytes', () => {
      const malicious = 'file\x00.txt'
      const sanitized = sanitizePath(malicious)

      expect(sanitized).to.not.include('\x00')
    })

    it('should allow normal paths', () => {
      const normal = 'path/to/file.txt'
      const sanitized = sanitizePath(normal)

      expect(sanitized).to.equal(normal)
    })

    it('should handle empty string', () => {
      const sanitized = sanitizePath('')

      expect(sanitized).to.equal('')
    })
  })

  describe('parseTimeString', () => {
    it('should parse milliseconds', () => {
      expect(parseTimeString('1000ms')).to.equal(1000)
      expect(parseTimeString('500ms')).to.equal(500)
    })

    it('should parse seconds', () => {
      expect(parseTimeString('5s')).to.equal(5000)
      expect(parseTimeString('10s')).to.equal(10000)
    })

    it('should parse minutes', () => {
      expect(parseTimeString('2m')).to.equal(120000)
      expect(parseTimeString('5m')).to.equal(300000)
    })

    it('should parse hours', () => {
      expect(parseTimeString('1h')).to.equal(3600000)
      expect(parseTimeString('2h')).to.equal(7200000)
    })

    it('should parse days', () => {
      expect(parseTimeString('1d')).to.equal(86400000)
      expect(parseTimeString('7d')).to.equal(604800000)
    })

    it('should handle invalid format', () => {
      expect(parseTimeString('invalid')).to.be.NaN
    })

    it('should handle negative values', () => {
      expect(parseTimeString('-5s')).to.equal(-5000)
    })
  })
})

