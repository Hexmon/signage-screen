const { expect } = require('chai')

describe('Runtime mode policy', () => {
  it('should keep dev mode interactive and windowed', () => {
    const { getRuntimeWindowPolicy } = require('../../../src/main/runtime-mode')

    const policy = getRuntimeWindowPolicy('dev')

    expect(policy.fullscreen).to.equal(false)
    expect(policy.kiosk).to.equal(false)
    expect(policy.frame).to.equal(true)
    expect(policy.disableInput).to.equal(false)
    expect(policy.hideCursor).to.equal(false)
  })

  it('should lock the window in qa mode', () => {
    const { getRuntimeWindowPolicy } = require('../../../src/main/runtime-mode')

    const policy = getRuntimeWindowPolicy('qa')

    expect(policy.fullscreen).to.equal(true)
    expect(policy.kiosk).to.equal(true)
    expect(policy.frame).to.equal(false)
    expect(policy.disableInput).to.equal(true)
    expect(policy.hideCursor).to.equal(true)
  })

  it('should treat production the same as qa for kiosk policy', () => {
    const { getRuntimeWindowPolicy, isLockedRuntime } = require('../../../src/main/runtime-mode')

    const policy = getRuntimeWindowPolicy('production')

    expect(isLockedRuntime('production')).to.equal(true)
    expect(policy.fullscreen).to.equal(true)
    expect(policy.kiosk).to.equal(true)
    expect(policy.disableInput).to.equal(true)
  })
})
