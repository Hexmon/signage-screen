# Testing Guide

## Overview

The HexmonSignage Player includes a comprehensive test suite covering unit tests, integration tests, performance tests, and fault injection tests.

## Test Framework

- **Framework**: Mocha
- **Assertions**: Chai
- **Mocking**: Sinon
- **Coverage**: NYC (Istanbul)

## Running Tests

### Install Dependencies

```bash
npm install
```

### Run All Tests

```bash
npm test
```

This runs both unit and integration tests.

### Run Specific Test Suites

```bash
# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Performance tests only
npm run test:performance

# Fault injection tests only
npm run test:fault

# All tests including performance and fault injection
npm run test:all
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

### Generate Coverage Report

```bash
npm run test:coverage
```

Coverage reports are generated in `coverage/` directory.

## Test Structure

```
test/
├── setup.ts                    # Global test setup
├── helpers/
│   └── test-utils.ts          # Test utility functions
├── fixtures/
│   ├── test-config.json       # Test configuration
│   ├── cache/                 # Test cache directory
│   ├── certs/                 # Test certificates
│   └── logs/                  # Test logs
├── unit/                      # Unit tests
│   ├── common/
│   │   ├── utils.test.ts
│   │   ├── config.test.ts
│   │   └── logger.test.ts
│   └── services/
│       ├── cache-manager.test.ts
│       ├── cert-manager.test.ts
│       ├── pairing-service.test.ts
│       └── ...
├── integration/               # Integration tests
│   ├── pairing-flow.test.ts
│   ├── playback-pipeline.test.ts
│   └── offline-mode.test.ts
├── performance/               # Performance tests
│   ├── timeline-jitter.test.ts
│   └── resource-usage.test.ts
└── fault-injection/           # Fault injection tests
    ├── network-failures.test.ts
    ├── disk-full.test.ts
    └── corrupted-files.test.ts
```

## Test Categories

### 1. Unit Tests

Test individual components in isolation with mocked dependencies.

**Location**: `test/unit/`

**Coverage**:
- Common utilities (utils, config, logger)
- Certificate Manager
- Cache Manager
- Network Client (HTTP/WebSocket)
- Pairing Service
- Telemetry Service
- Proof-of-Play Service
- Schedule Manager
- Playback Engine
- Command Processor
- Screenshot Service
- Power Manager
- Log Shipper

**Example**:
```typescript
describe('Cache Manager', () => {
  it('should add item to cache', async () => {
    const cacheManager = getCacheManager()
    await cacheManager.add('key', 'url', 'hash')
    expect(await cacheManager.has('key')).to.be.true
  })
})
```

### 2. Integration Tests

Test interactions between multiple components.

**Location**: `test/integration/`

**Coverage**:
- Complete pairing flow (CSR → certificate → mTLS)
- Schedule download → cache prefetch → playback
- Offline scenarios (queue, cache, reconnection)
- Proof-of-Play event flow
- Command processing flow

**Example**:
```typescript
describe('Pairing Flow Integration', () => {
  it('should complete pairing flow successfully', async () => {
    // Generate CSR
    const csr = await certManager.generateCSR(...)
    
    // Submit pairing
    const result = await pairingService.submitPairing('ABC123')
    
    // Verify certificates stored
    expect(fs.existsSync(certPath)).to.be.true
  })
})
```

### 3. Performance Tests

Measure and validate performance targets.

**Location**: `test/performance/`

**Targets**:
- Timeline jitter: ≤100ms p95
- CPU usage: <40% p95
- Memory usage: <500MB p95
- Startup time: ≤5s cold start

**Example**:
```typescript
describe('Timeline Jitter Performance', () => {
  it('should maintain jitter ≤100ms p95', async () => {
    // Measure jitter over time
    const stats = scheduler.getJitterStats()
    expect(stats.p95).to.be.lessThan(100)
  })
})
```

### 4. Fault Injection Tests

Test resilience under failure conditions.

**Location**: `test/fault-injection/`

**Scenarios**:
- Network failures (timeout, DNS, connection refused)
- Disk full
- Corrupted cache files
- Invalid certificates
- Malformed API responses
- WebSocket disconnections

**Example**:
```typescript
describe('Network Failure Fault Injection', () => {
  it('should retry on connection timeout', async () => {
    mockRequest.onCall(0).rejects(new Error('ETIMEDOUT'))
    mockRequest.onCall(1).resolves({ data: 'success' })
    
    const result = await retryWithBackoff(mockRequest, 3, 100)
    expect(result.data).to.equal('success')
  })
})
```

## Writing Tests

### Test File Naming

- Unit tests: `*.test.ts`
- Integration tests: `*.test.ts`
- Performance tests: `*.test.ts`
- Fault injection tests: `*.test.ts`

### Test Structure

```typescript
import { expect } from 'chai'
import * as sinon from 'sinon'

describe('Component Name', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    // Setup
  })

  afterEach(() => {
    sandbox.restore()
    // Cleanup
  })

  describe('Feature', () => {
    it('should do something', () => {
      // Arrange
      const input = 'test'
      
      // Act
      const result = doSomething(input)
      
      // Assert
      expect(result).to.equal('expected')
    })
  })
})
```

### Mocking

Use Sinon for mocking:

```typescript
// Stub function
const stub = sandbox.stub(object, 'method')
stub.returns('value')
stub.resolves('async value')
stub.rejects(new Error('error'))

// Spy on function
const spy = sandbox.spy(object, 'method')
expect(spy.calledOnce).to.be.true

// Mock entire object
const mock = {
  method: sandbox.stub().returns('value')
}
```

### Assertions

Use Chai assertions:

```typescript
// Equality
expect(value).to.equal(expected)
expect(value).to.deep.equal(expected)

// Truthiness
expect(value).to.be.true
expect(value).to.be.false
expect(value).to.exist

// Comparisons
expect(value).to.be.greaterThan(5)
expect(value).to.be.lessThan(10)

// Arrays
expect(array).to.include('item')
expect(array).to.have.lengthOf(3)

// Objects
expect(object).to.have.property('key')
expect(object).to.have.property('key', 'value')

// Errors
expect(() => fn()).to.throw()
expect(() => fn()).to.throw(Error, 'message')
```

## Test Utilities

### Helper Functions

Located in `test/helpers/test-utils.ts`:

```typescript
// Create temporary directory
const tempDir = createTempDir('prefix-')

// Cleanup temporary directory
cleanupTempDir(tempDir)

// Create test file
const buffer = createTestFile(filePath, sizeBytes)

// Calculate hash
const hash = calculateHash(buffer)

// Wait for condition
await waitFor(() => condition, timeoutMs)

// Sleep
await sleep(ms)

// Mock certificate
const cert = createMockCertificate()

// Mock schedule
const schedule = createMockSchedule(itemCount)

// Mock BrowserWindow
const window = createMockBrowserWindow()
```

## Cross-Platform Testing

### Platform Detection

```typescript
import { isWindows, isLinux } from '../helpers/test-utils'

if (isLinux()) {
  // Linux-specific tests
}

if (isWindows()) {
  // Windows-specific tests
}
```

### Skipping Platform-Specific Tests

```typescript
it('should control DPMS (Linux only)', function() {
  if (!isLinux()) {
    this.skip()
    return
  }
  
  // Test DPMS control
})
```

## Continuous Integration

### GitHub Actions

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm install
      - run: npm run test:all
      - run: npm run test:coverage
```

## Coverage Goals

- **Overall**: 80%+
- **Critical paths**: 90%+
- **Utilities**: 95%+

## Debugging Tests

### Run Single Test

```bash
npx mocha --require ts-node/register test/unit/common/utils.test.ts
```

### Run Single Test Case

```bash
npx mocha --require ts-node/register test/unit/common/utils.test.ts --grep "should calculate hash"
```

### Enable Debug Output

```bash
DEBUG=* npm test
```

### Increase Timeout

```typescript
it('slow test', async function() {
  this.timeout(10000) // 10 seconds
  // Test code
})
```

## Best Practices

1. **Isolate Tests**: Each test should be independent
2. **Mock External Dependencies**: Don't make real network calls
3. **Clean Up**: Always clean up resources in `afterEach`
4. **Descriptive Names**: Use clear, descriptive test names
5. **Arrange-Act-Assert**: Follow AAA pattern
6. **Test Edge Cases**: Test boundary conditions and errors
7. **Fast Tests**: Keep unit tests fast (<100ms each)
8. **Deterministic**: Tests should always produce same result

## Troubleshooting

### Tests Fail on Windows

Some tests may be Linux-specific (DPMS, xrandr). These should be skipped on Windows.

### Timeout Errors

Increase timeout for slow tests:
```typescript
this.timeout(10000)
```

### Module Not Found

Clear module cache:
```typescript
delete require.cache[require.resolve('module')]
```

### Port Already in Use

Tests may fail if ports are in use. Ensure no other instances are running.

## Manual QA Checklist

Use this checklist to validate the Electron pairing and authenticated runtime flow against `DEVICE_PAIRING_API_FLOW_WITH_CURLS.md`.

### Pairing And Provisioning

1. Start the player with no local identity and verify it enters `HARD_RECOVERY`, requests a fresh pairing code, and transitions to `PAIRING_PENDING` once the request succeeds.
2. Verify the pairing screen shows the current `pairing_code`, `device_id`, and expiry countdown.
3. Approve the device in backend/admin and verify status reaches `confirmed === true` with `screen === null`, then the player moves through `PAIRING_CONFIRMED` to `PAIRING_COMPLETING`.
4. Verify main generates or reuses the private key, generates the CSR, installs certificate and CA, persists fingerprint, clears `pairing_code` and `pairing_expires_at`, and transitions to `PAIRED_RUNTIME`.
5. Restart the app after successful completion and verify it restores directly into `PAIRED_RUNTIME`.

### Pairing Failure Cases

1. Force temporary network failure during pairing status polling and verify the pairing code remains visible while polling retries with backoff.
2. Force pairing completion to return `Pairing not confirmed` and verify the player returns to polling instead of failing pairing.
3. Force pairing completion to return `Invalid or expired pairing code` and verify stale pairing metadata is cleared and a fresh pairing request is started.
4. Simulate a pairing request failure during hard recovery and verify the player stays in `HARD_RECOVERY` without showing a stale pairing code.
5. Retry fresh pairing from hard recovery and verify a new pairing request is created only after the retry action succeeds.

### Runtime And Recovery

1. With valid credentials, verify heartbeat, command fetch, command ack, proof-of-play, and screenshot requests all use the same `x-device-serial` mapping path.
2. Deliver the same command once via heartbeat inline commands and once via `GET /commands` and verify it executes only once and is acknowledged once.
3. Restart the app after a command has been seen but before ack replay completes and verify the recent-command ledger prevents duplicate execution.
4. Force `403 Invalid device credentials` while playable content is cached and verify playback continues, runtime loops stop, and the UI enters `RECOVERY_REQUIRED` without auto re-pairing.
5. Force `404 Device not registered` and verify the UI enters `HARD_RECOVERY`, preserves playback if local content exists, and starts fresh pairing after the countdown.

### Offline And Queueing

1. Disconnect the network during runtime and verify current playback continues when cached content exists.
2. While offline, generate proof-of-play events and verify they are spooled locally and replayed in order when connectivity returns.
3. Force screenshot upload failures and verify they remain best-effort, do not block playback, and do not block proof-of-play replay.
4. Restart the app while proof-of-play events are queued and verify the backlog is restored and replayed after connectivity returns.
5. Restart the app with partial identity states such as `device_id` without key, key without certificate, or certificate without fingerprint and verify startup enters `RECOVERY_REQUIRED` with an actionable reason instead of showing fresh pairing UI immediately.

## Resources

- [Mocha Documentation](https://mochajs.org/)
- [Chai Assertions](https://www.chaijs.com/api/)
- [Sinon Mocking](https://sinonjs.org/)
- [NYC Coverage](https://github.com/istanbuljs/nyc)

---

**Last Updated**: 2026-03-11
