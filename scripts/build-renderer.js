/**
 * Bundle renderer scripts using esbuild
 */

const esbuild = require('esbuild')
const path = require('path')
const fs = require('fs')

async function build() {
  try {
    const distRendererDir = path.join(__dirname, '../dist/renderer')
    if (!fs.existsSync(distRendererDir)) {
      fs.mkdirSync(distRendererDir, { recursive: true })
    }

    // Bundle player.js
    await esbuild.build({
      entryPoints: [path.join(__dirname, '../src/renderer/player.ts')],
      bundle: true,
      outfile: path.join(__dirname, '../dist/renderer/player.bundle.js'),
      platform: 'browser',
      target: 'es2020',
      sourcemap: true,
      format: 'iife', // Immediately Invoked Function Expression for browser
      external: ['electron'], // Don't bundle electron
    })

    // Bundle pairing.js
    await esbuild.build({
      entryPoints: [path.join(__dirname, '../src/renderer/pairing.ts')],
      bundle: true,
      outfile: path.join(__dirname, '../dist/renderer/pairing.bundle.js'),
      platform: 'browser',
      target: 'es2020',
      sourcemap: true,
      format: 'iife',
      external: ['electron'],
    })

    // Bundle diagnostics.js
    await esbuild.build({
      entryPoints: [path.join(__dirname, '../src/renderer/diagnostics.ts')],
      bundle: true,
      outfile: path.join(__dirname, '../dist/renderer/diagnostics.bundle.js'),
      platform: 'browser',
      target: 'es2020',
      sourcemap: true,
      format: 'iife',
      external: ['electron'],
    })

    console.log('✓ Renderer scripts bundled successfully')
  } catch (error) {
    console.error('Failed to bundle renderer scripts:', error)
    process.exit(1)
  }
}

build()
