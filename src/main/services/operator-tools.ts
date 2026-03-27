import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getConfigManager } from '../../common/config'
import type { AppConfig } from '../../common/types'
import { ensureDir, findExecutable, formatBytes, generateId, getDirectorySize } from '../../common/utils'
import { getLogger } from '../../common/logger'
import { getElectronApp } from '../../common/platform-paths'
import { getCertificateManager } from './cert-manager'
import { getPairingService } from './pairing-service'
import { getPowerManager } from './power-manager'
import { getAutostartStatus } from './autostart'

const logger = getLogger('operator-tools')

function getAppMetadata() {
  const electronApp = getElectronApp()
  return {
    version: typeof electronApp?.getVersion === 'function' ? electronApp.getVersion() : process.env['npm_package_version'] || 'unknown',
    packaged: Boolean(electronApp?.isPackaged),
    execPath: process.execPath,
  }
}

function redactConfigForSupport(config: AppConfig) {
  return {
    ...config,
    apiBase: '[REDACTED]',
    wsUrl: '[REDACTED]',
    deviceId: config.deviceId ? '[REDACTED]' : '',
    mtls: {
      ...config.mtls,
      certPath: '[REDACTED]',
      keyPath: '[REDACTED]',
      caPath: '[REDACTED]',
    },
  }
}

function pathExists(targetPath: string) {
  try {
    fs.accessSync(targetPath)
    return true
  } catch {
    return false
  }
}

function writeJsonFile(targetPath: string, payload: unknown) {
  ensureDir(path.dirname(targetPath))
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2), 'utf-8')
}

async function getCacheStats(cachePath: string) {
  const mediaPath = path.join(cachePath, 'media')
  const logsPath = path.join(cachePath, 'logs')
  const popPath = path.join(cachePath, 'pop-spool')
  const screenshotPath = path.join(cachePath, 'screenshots')

  return {
    root: cachePath,
    rootExists: pathExists(cachePath),
    media: {
      path: mediaPath,
      exists: pathExists(mediaPath),
      bytes: await getDirectorySize(mediaPath),
    },
    logs: {
      path: logsPath,
      exists: pathExists(logsPath),
      bytes: await getDirectorySize(logsPath),
    },
    proofOfPlay: {
      path: popPath,
      exists: pathExists(popPath),
      bytes: await getDirectorySize(popPath),
    },
    screenshots: {
      path: screenshotPath,
      exists: pathExists(screenshotPath),
      bytes: await getDirectorySize(screenshotPath),
    },
  }
}

export async function runDoctor() {
  const configManager = getConfigManager()
  const config = configManager.getConfig()
  const runtimePaths = configManager.getRuntimePaths()
  const pairingService = getPairingService()
  const certManager = getCertificateManager()
  const powerManager = getPowerManager()
  const diagnostics = await pairingService.runDiagnostics()
  const displays = await powerManager.getDisplayInfo()
  const cacheStats = await getCacheStats(config.cache.path)
  const certificateMetadata = certManager.getCertificateMetadata()
  const certificatePaths = certManager.getCertificatePaths()
  const appMetadata = getAppMetadata()

  const report = {
    timestamp: new Date().toISOString(),
    app: {
      ...appMetadata,
      runtimeMode: config.runtime.mode,
    },
    host: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
    },
    paths: {
      configPath: configManager.getConfigPath(),
      runtimeRoot: runtimePaths.runtimeRoot,
      cachePath: config.cache.path,
      certDir: runtimePaths.certDir,
      configExists: pathExists(configManager.getConfigPath()),
      cacheExists: pathExists(config.cache.path),
      certPaths: certificatePaths,
    },
    pairing: {
      deviceId: pairingService.getDeviceId() || null,
      paired: pairingService.isPairedDevice(),
      identityHealth: pairingService.getStoredIdentityHealth(),
      certificateMetadata,
    },
    network: diagnostics,
    autostart: getAutostartStatus(),
    display: {
      capabilities: powerManager.getCapabilities(),
      displays,
    },
    dependencies: {
      xset: findExecutable('xset'),
      xrandr: findExecutable('xrandr'),
    },
    cache: {
      ...cacheStats,
      humanReadable: {
        media: formatBytes(cacheStats.media.bytes),
        logs: formatBytes(cacheStats.logs.bytes),
        proofOfPlay: formatBytes(cacheStats.proofOfPlay.bytes),
        screenshots: formatBytes(cacheStats.screenshots.bytes),
      },
    },
  }

  console.log(JSON.stringify(report, null, 2))
  return 0
}

export async function clearCache() {
  const cacheRoot = getConfigManager().getConfig().cache.path
  const targets = ['media', 'objects', 'quarantine']
  const removed: string[] = []

  for (const name of targets) {
    const targetPath = path.join(cacheRoot, name)
    if (!pathExists(targetPath)) {
      continue
    }

    fs.rmSync(targetPath, { recursive: true, force: true })
    ensureDir(targetPath)
    removed.push(targetPath)
  }

  const legacyIndex = path.join(cacheRoot, 'cache-index.db')
  if (pathExists(legacyIndex)) {
    fs.rmSync(legacyIndex, { force: true })
    removed.push(legacyIndex)
  }

  logger.info({ removed }, 'Cleared media cache')
  console.log(JSON.stringify({ success: true, cacheRoot, removed }, null, 2))
  return 0
}

export async function collectLogs() {
  const configManager = getConfigManager()
  const config = configManager.getConfig()
  const bundleDir = path.join(os.tmpdir(), `hexmon-support-${Date.now()}-${generateId(6)}`)
  const cacheRoot = config.cache.path
  const logDir = path.join(cacheRoot, 'logs')
  const screenshotDir = path.join(cacheRoot, 'screenshots')
  const popDir = path.join(cacheRoot, 'pop-spool')
  const diagnostics = await getPairingService().runDiagnostics()
  const displays = await getPowerManager().getDisplayInfo()
  const cacheStats = await getCacheStats(cacheRoot)

  ensureDir(bundleDir)

  if (pathExists(logDir)) {
    fs.cpSync(logDir, path.join(bundleDir, 'logs'), { recursive: true })
  }

  if (pathExists(screenshotDir)) {
    fs.cpSync(screenshotDir, path.join(bundleDir, 'screenshots'), { recursive: true })
  }

  if (pathExists(popDir)) {
    fs.cpSync(popDir, path.join(bundleDir, 'proof-of-play-spool'), { recursive: true })
  }

  writeJsonFile(path.join(bundleDir, 'config.redacted.json'), redactConfigForSupport(config))
  writeJsonFile(path.join(bundleDir, 'diagnostics.json'), diagnostics)
  writeJsonFile(path.join(bundleDir, 'displays.json'), displays)
  writeJsonFile(path.join(bundleDir, 'autostart.json'), getAutostartStatus())
  writeJsonFile(path.join(bundleDir, 'cache-stats.json'), cacheStats)
  writeJsonFile(path.join(bundleDir, 'certificate-metadata.json'), getCertificateManager().getCertificateMetadata())
  writeJsonFile(path.join(bundleDir, 'system-info.json'), {
    timestamp: new Date().toISOString(),
    appVersion: getAppMetadata().version,
    execPath: getAppMetadata().execPath,
    packaged: getAppMetadata().packaged,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    runtimePaths: configManager.getRuntimePaths(),
  })

  console.log(JSON.stringify({ success: true, bundleDir }, null, 2))
  return 0
}

export async function requestPairingCodeForCli() {
  const response = await getPairingService().requestPairingCode()
  console.log(JSON.stringify(response, null, 2))
  return 0
}

export async function submitPairingCodeForCli(pairingCode: string) {
  const response = await getPairingService().submitPairing(pairingCode)
  console.log(
    JSON.stringify(
      {
        success: true,
        device_id: response.device_id,
        fingerprint: response.fingerprint,
      },
      null,
      2
    )
  )
  return 0
}
