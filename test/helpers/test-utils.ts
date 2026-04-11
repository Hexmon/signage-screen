/**
 * Test utility functions and helpers
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import forge from 'node-forge'

/**
 * Create a temporary directory for tests
 */
export function createTempDir(prefix: string = 'test-'): string {
  const tempDir = path.join(__dirname, '..', 'fixtures', 'temp', `${prefix}${Date.now()}`)
  fs.mkdirSync(tempDir, { recursive: true })
  return tempDir
}

/**
 * Clean up temporary directory
 */
export function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Create a test file with random content
 */
export function createTestFile(filePath: string, sizeBytes: number = 1024): Buffer {
  const buffer = crypto.randomBytes(sizeBytes)
  fs.writeFileSync(filePath, buffer)
  return buffer
}

/**
 * Calculate SHA-256 hash of buffer
 */
export function calculateHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<void> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return
    }
    await sleep(intervalMs)
  }

  throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`)
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create a mock certificate for testing
 */
export function createMockCertificate(): {
  key: string
  cert: string
  csr: string
} {
  return {
    key: `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIIGlRjzCh6kp7VlLnJ8xKqXqYqXqYqXqYqXqYqXqYqXqoAoGCCqGSM49
AwEHoUQDQgAEYqXqYqXqYqXqYqXqYqXqYqXqYqXqYqXqYqXqYqXqYqXqYqXqYqXq
YqXqYqXqYqXqYqXqYqXqYqXqYqXqYqXqYg==
-----END EC PRIVATE KEY-----`,
    cert: `-----BEGIN CERTIFICATE-----
MIIBkTCCATigAwIBAgIUYqXqYqXqYqXqYqXqYqXqYqXqYqUwCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHVGVzdCBDQTAeFw0yNTAxMDUwMDAwMDBaFw0yNjAxMDUwMDAw
MDBaMBIxEDAOBgNVBAMMB1Rlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AARipepipepipepipepipepipepipepipepipepipepipepipepipepipepipepipe
o1MwUTAdBgNVHQ4EFgQUYqXqYqXqYqXqYqXqYqXqYqXqYqUwHwYDVR0jBBgwFoAU
YqXqYqXqYqXqYqXqYqXqYqXqYqUwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AgNHADBEAiBipepipepipepipepipepipepipepipepipepipeAiAYqXqYqXqYqXq
YqXqYqXqYqXqYqXqYqXqYqXqYqXqYqXqYg==
-----END CERTIFICATE-----`,
    csr: `-----BEGIN CERTIFICATE REQUEST-----
MIIBCjCBsQIBADBSMQswCQYDVQQGEwJVUzEWMBQGA1UECgwNSGV4bW9uU2lnbmFn
ZTErMCkGA1UEAwwiZGV2aWNlLXRlc3QtMTIzLmhlZG1vbnNpZ25hZ2UubG9jYWww
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARipepipepipepipepipepipepipepipe
pipepipepipepipepipepipepipepipepipeoAAwCgYIKoZIzj0EAwIDSAAwRQIh
AJipepipepipepipepipepipepipepipepipepipeAiAYqXqYqXqYqXqYqXqYqXqYqXq
YqXqYqXqYqXqYqXqYqXqYg==
-----END CERTIFICATE REQUEST-----`,
  }
}

export function createTestCertificateAuthority(commonName: string = 'Hexmon Test CA'): {
  certPem: string
  keyPem: string
} {
  const keyPair = forge.pki.rsa.generateKeyPair(2048)
  const certificate = forge.pki.createCertificate()
  certificate.publicKey = keyPair.publicKey
  certificate.serialNumber = '1001'
  certificate.validity.notBefore = new Date(Date.now() - 60 * 1000)
  certificate.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  certificate.setSubject([{ name: 'commonName', value: commonName }])
  certificate.setIssuer([{ name: 'commonName', value: commonName }])
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: 'subjectKeyIdentifier' },
  ])
  certificate.sign(keyPair.privateKey, forge.md.sha256.create())

  return {
    certPem: forge.pki.certificateToPem(certificate),
    keyPem: forge.pki.privateKeyToPem(keyPair.privateKey),
  }
}

export function issueSignedCertificateFromCsr(
  csrPem: string,
  options: {
    caCertPem?: string
    caKeyPem?: string
    serialNumber?: string
    validDays?: number
  } = {}
): {
  certPem: string
  caCertPem: string
  caKeyPem: string
} {
  const ca = options.caCertPem && options.caKeyPem
    ? { certPem: options.caCertPem, keyPem: options.caKeyPem }
    : createTestCertificateAuthority()

  const csr = forge.pki.certificationRequestFromPem(csrPem)
  if (!csr.verify()) {
    throw new Error('CSR verification failed in test helper')
  }

  const certificate = forge.pki.createCertificate()
  certificate.publicKey = csr.publicKey
  certificate.serialNumber = options.serialNumber || '1002'
  certificate.validity.notBefore = new Date(Date.now() - 60 * 1000)
  certificate.validity.notAfter = new Date(
    Date.now() + (options.validDays ?? 365) * 24 * 60 * 60 * 1000
  )
  certificate.setSubject(csr.subject.attributes)

  const caCertificate = forge.pki.certificateFromPem(ca.certPem)
  const caPrivateKey = forge.pki.privateKeyFromPem(ca.keyPem)
  certificate.setIssuer(caCertificate.subject.attributes)
  certificate.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: true, authorityCertIssuer: true, serialNumber: caCertificate.serialNumber },
  ])
  certificate.sign(caPrivateKey, forge.md.sha256.create())

  return {
    certPem: forge.pki.certificateToPem(certificate),
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
  }
}

/**
 * Create a mock schedule for testing
 */
export function createMockSchedule(itemCount: number = 3): any {
  const items = []
  for (let i = 0; i < itemCount; i++) {
    items.push({
      id: `item_${i}`,
      type: i % 2 === 0 ? 'image' : 'video',
      objectKey: `media/test-${i}.jpg`,
      sha256: crypto.randomBytes(32).toString('hex'),
      displayMs: 10000,
      fit: 'contain',
      transitionDurationMs: 500,
    })
  }

  return {
    id: `schedule_${Date.now()}`,
    version: 1,
    updated_at: new Date().toISOString(),
    items,
  }
}

/**
 * Mock Electron BrowserWindow
 */
export function createMockBrowserWindow(): any {
  return {
    webContents: {
      send: () => {},
      capturePage: async () => ({
        toPNG: () => Buffer.from('mock-png-data'),
        toJPEG: () => Buffer.from('mock-jpeg-data'),
      }),
    },
    on: () => {},
    once: () => {},
    removeListener: () => {},
  }
}

/**
 * Mock HTTP response
 */
export function createMockHttpResponse<T>(data: T, status: number = 200): any {
  return {
    data,
    status,
    statusText: 'OK',
    headers: {},
    config: {},
  }
}

/**
 * Mock WebSocket
 */
export function createMockWebSocket(): any {
  const listeners: Map<string, Function[]> = new Map()

  return {
    on: (event: string, callback: Function) => {
      if (!listeners.has(event)) {
        listeners.set(event, [])
      }
      listeners.get(event)!.push(callback)
    },
    emit: (event: string, ...args: any[]) => {
      const callbacks = listeners.get(event) || []
      callbacks.forEach((cb) => cb(...args))
    },
    send: () => {},
    close: () => {},
    readyState: 1, // OPEN
  }
}

/**
 * Measure execution time
 */
export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; timeMs: number }> {
  const start = Date.now()
  const result = await fn()
  const timeMs = Date.now() - start
  return { result, timeMs }
}

/**
 * Generate random string
 */
export function randomString(length: number = 10): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
}

/**
 * Check if running on Windows
 */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * Check if running on Linux
 */
export function isLinux(): boolean {
  return process.platform === 'linux'
}
