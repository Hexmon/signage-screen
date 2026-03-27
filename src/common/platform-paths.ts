import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { App as ElectronApp, Screen as ElectronScreen } from 'electron'

export interface RuntimePaths {
  runtimeRoot: string
  configPath: string
  cachePath: string
  certDir: string
  legacyLinux: {
    configPath: string
    cachePath: string
    certDir: string
  }
}

export interface LegacyImportResult {
  imported: boolean
  items: string[]
  markerPath: string
}

function getEnvOverride(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function hasExplicitRuntimePathOverrides(): boolean {
  return [
    'SIGNAGE_CONFIG_PATH',
    'HEXMON_CONFIG_PATH',
    'HEXMON_CACHE_PATH',
    'HEXMON_MTLS_CERT_DIR',
    'HEXMON_MTLS_CERT_PATH',
    'HEXMON_MTLS_KEY_PATH',
    'HEXMON_MTLS_CA_PATH',
  ].some((name) => Boolean(getEnvOverride(name)))
}

export function getElectronApp(): ElectronApp | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as typeof import('electron')
    if (electron && typeof electron === 'object' && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app
    }
  } catch {
    return undefined
  }

  return undefined
}

export function getElectronScreen(): ElectronScreen | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as typeof import('electron')
    if (electron && typeof electron === 'object' && electron.screen && typeof electron.screen.getAllDisplays === 'function') {
      return electron.screen
    }
  } catch {
    return undefined
  }

  return undefined
}

function getFallbackRuntimeRoot(platform: NodeJS.Platform): string {
  const homeDir = os.homedir() || os.tmpdir()

  switch (platform) {
    case 'win32':
      return path.join(process.env['APPDATA'] || path.join(homeDir, 'AppData', 'Roaming'), 'HexmonSignage Player')
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'HexmonSignage Player')
    default:
      return path.join(homeDir, '.config', 'hexmon-signage-player')
  }
}

export function resolveRuntimePaths(appInstance?: ElectronApp): RuntimePaths {
  const configOverride = getEnvOverride('SIGNAGE_CONFIG_PATH') || getEnvOverride('HEXMON_CONFIG_PATH')
  const runtimeRoot =
    getEnvOverride('HEXMON_RUNTIME_ROOT') ||
    appInstance?.getPath('userData') ||
    getElectronApp()?.getPath('userData') ||
    getFallbackRuntimeRoot(os.platform())

  const configPath = configOverride || path.join(runtimeRoot, 'config.json')
  const cachePath = getEnvOverride('HEXMON_CACHE_PATH') || path.join(runtimeRoot, 'cache')
  const certDir = getEnvOverride('HEXMON_MTLS_CERT_DIR') || path.join(runtimeRoot, 'certs')

  return {
    runtimeRoot,
    configPath,
    cachePath,
    certDir,
    legacyLinux: {
      configPath: '/etc/hexmon/config.json',
      cachePath: '/var/cache/hexmon',
      certDir: '/var/lib/hexmon/certs',
    },
  }
}

function pathExists(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath)
    return true
  } catch {
    return false
  }
}

function directoryHasEntries(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath) && fs.readdirSync(targetPath).length > 0
  } catch {
    return false
  }
}

function ensureDirectory(targetPath: string, mode = 0o755): void {
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true, mode })
  }
}

function usesLegacyPrefix(candidate: unknown, legacyRoot: string): boolean {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return false
  }

  const resolvedCandidate = path.resolve(candidate)
  const resolvedLegacy = path.resolve(legacyRoot)
  return resolvedCandidate === resolvedLegacy || resolvedCandidate.startsWith(`${resolvedLegacy}${path.sep}`)
}

function rewriteLegacyConfigPaths(rawConfig: Record<string, any>, runtimePaths: RuntimePaths) {
  const nextConfig = { ...rawConfig }
  const cache = { ...(typeof rawConfig['cache'] === 'object' && rawConfig['cache'] ? rawConfig['cache'] : {}) }
  const mtls = { ...(typeof rawConfig['mtls'] === 'object' && rawConfig['mtls'] ? rawConfig['mtls'] : {}) }

  if (!cache['path'] || usesLegacyPrefix(cache['path'], runtimePaths.legacyLinux.cachePath)) {
    cache['path'] = runtimePaths.cachePath
  }

  if (!mtls['certPath'] || usesLegacyPrefix(mtls['certPath'], runtimePaths.legacyLinux.certDir)) {
    mtls['certPath'] = path.join(runtimePaths.certDir, 'client.crt')
  }

  if (!mtls['keyPath'] || usesLegacyPrefix(mtls['keyPath'], runtimePaths.legacyLinux.certDir)) {
    mtls['keyPath'] = path.join(runtimePaths.certDir, 'client.key')
  }

  if (!mtls['caPath'] || usesLegacyPrefix(mtls['caPath'], runtimePaths.legacyLinux.certDir)) {
    mtls['caPath'] = path.join(runtimePaths.certDir, 'ca.crt')
  }

  nextConfig['cache'] = cache
  nextConfig['mtls'] = mtls
  return nextConfig
}

export function importLegacyLinuxRuntimeState(runtimePaths: RuntimePaths): LegacyImportResult {
  const markerPath = path.join(runtimePaths.runtimeRoot, '.legacy-linux-imported.json')

  if (os.platform() !== 'linux' || hasExplicitRuntimePathOverrides()) {
    return { imported: false, items: [], markerPath }
  }

  if (pathExists(markerPath)) {
    return { imported: false, items: [], markerPath }
  }

  ensureDirectory(runtimePaths.runtimeRoot)
  const importedItems: string[] = []

  if (!pathExists(runtimePaths.configPath) && pathExists(runtimePaths.legacyLinux.configPath)) {
    try {
      const rawConfig = JSON.parse(fs.readFileSync(runtimePaths.legacyLinux.configPath, 'utf-8')) as Record<string, any>
      const rewritten = rewriteLegacyConfigPaths(rawConfig, runtimePaths)
      ensureDirectory(path.dirname(runtimePaths.configPath))
      fs.writeFileSync(runtimePaths.configPath, JSON.stringify(rewritten, null, 2), { mode: 0o600 })
      importedItems.push('config')
    } catch {
      // If legacy config is unreadable, leave import state empty and let defaults win.
    }
  }

  if (pathExists(runtimePaths.legacyLinux.certDir) && !directoryHasEntries(runtimePaths.certDir)) {
    ensureDirectory(path.dirname(runtimePaths.certDir))
    fs.cpSync(runtimePaths.legacyLinux.certDir, runtimePaths.certDir, { recursive: true, force: false })
    importedItems.push('certs')
  }

  if (pathExists(runtimePaths.legacyLinux.cachePath) && !directoryHasEntries(runtimePaths.cachePath)) {
    ensureDirectory(path.dirname(runtimePaths.cachePath))
    fs.cpSync(runtimePaths.legacyLinux.cachePath, runtimePaths.cachePath, { recursive: true, force: false })
    importedItems.push('cache')
  }

  fs.writeFileSync(
    markerPath,
    JSON.stringify(
      {
        importedAt: new Date().toISOString(),
        items: importedItems,
      },
      null,
      2
    ),
    { mode: 0o600 }
  )

  return {
    imported: importedItems.length > 0,
    items: importedItems,
    markerPath,
  }
}
