const { expect } = require('chai')

describe('player CLI parser', () => {
  afterEach(() => {
    delete require.cache[require.resolve('../../../src/main/cli')]
  })

  it('parses doctor flag', () => {
    const { parseOperatorCommand } = require('../../../src/main/cli')
    expect(parseOperatorCommand(['/path/to/electron', '.', '--doctor'])).to.deep.equal({ name: 'doctor' })
  })

  it('parses pair request subcommand', () => {
    const { parseOperatorCommand } = require('../../../src/main/cli')
    expect(parseOperatorCommand(['/path/to/player', 'pair', 'request'])).to.deep.equal({ name: 'pair-request' })
  })

  it('parses pair submit subcommand', () => {
    const { parseOperatorCommand } = require('../../../src/main/cli')
    expect(parseOperatorCommand(['/path/to/player', 'pair', 'submit', 'ABC123'])).to.deep.equal({
      name: 'pair-submit',
      pairingCode: 'ABC123',
    })
  })

  it('parses pair flag syntax', () => {
    const { parseOperatorCommand } = require('../../../src/main/cli')
    expect(parseOperatorCommand(['/path/to/player', '--pair=ZXCV12'])).to.deep.equal({
      name: 'pair-submit',
      pairingCode: 'ZXCV12',
    })
  })
})
