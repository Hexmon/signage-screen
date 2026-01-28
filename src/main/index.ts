/**
 * Main process entry point for HexmonSignage Player
 * Orchestrates all services and manages application lifecycle
 */

console.log('=== HexmonSignage Player Starting ===')
console.log('NODE_ENV:', process.env['NODE_ENV'])
console.log('__dirname:', __dirname)

import { app, BrowserWindow, screen } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getConfigManager } from '../common/config'
import { getLogger } from '../common/logger'
import { ExponentialBackoff } from '../common/utils'

console.log('Initializing logger...')
const logger = getLogger('main')
console.log('Logger initialized')
const config = getConfigManager()

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  logger.warn('Another instance is already running. Exiting.')
  app.quit()
} else {
  app.on('second-instance', () => {
    logger.warn('Attempted to start second instance')
    // Focus the existing window if it exists
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

let mainWindow: BrowserWindow | null = null
const restartBackoff = new ExponentialBackoff(1000, 60000, 10)

// Disable hardware acceleration if needed for stability
// app.disableHardwareAcceleration()

/**
 * Create the main browser window with kiosk settings
 */
function createWindow(): void {
  const appConfig = config.getConfig()
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  logger.info({ width, height }, 'Creating main window')

  mainWindow = new BrowserWindow({
    width,
    height,
    fullscreen: true,
    kiosk: true,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '../../renderer/preload/index.js'),
      nodeIntegration: appConfig.security.nodeIntegration,
      contextIsolation: appConfig.security.contextIsolation,
      sandbox: appConfig.security.sandbox,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: undefined,
    },
  })

  // Set Content Security Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [appConfig.security.csp],
      },
    })
  })

  // Load the renderer
  // Main process is at dist/main/main/index.js, renderer is at dist/renderer/index.html
  const rendererPath = path.join(__dirname, '../../renderer/index.html')
  logger.info({ rendererPath }, 'Loading renderer HTML')

  if (!fs.existsSync(rendererPath)) {
    logger.error(
      {
        rendererPath,
        hint: 'Run `npm run prepare:dev` or `npm run build` before launching Electron.',
      },
      'Renderer HTML not found'
    )
    const message = encodeURIComponent(
      `Renderer not built.\n\nExpected:\n${rendererPath}\n\nRun:\n- npm run prepare:dev\nor\n- npm run build`
    )
    void mainWindow.loadURL(`data:text/plain,${message}`)
  } else {
    mainWindow.loadFile(rendererPath)
      .then(() => {
        logger.info('Renderer HTML loaded successfully')
      })
      .catch((error) => {
        logger.error({ error, rendererPath }, 'Failed to load renderer')
      })
  }

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    logger.info('Main window shown')
    restartBackoff.reset()
  })

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null
    logger.info('Main window closed')
  })

  // Handle crashes - use render-process-gone instead of deprecated 'crashed'
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error({ reason: details.reason, exitCode: details.exitCode }, 'Renderer process gone')
    handleCrash()
  })

  // Prevent navigation away from the app
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL()

    if (currentUrl && url !== currentUrl) {
      logger.warn({ url }, 'Prevented navigation')
      event.preventDefault()
    }
  })

  // Prevent new window creation
  mainWindow.webContents.setWindowOpenHandler(() => {
    logger.warn('Prevented new window creation')
    return { action: 'deny' }
  })

  // Hide cursor if configured
  if (process.env['HEXMON_HIDE_CURSOR'] === 'true') {
    mainWindow.webContents.insertCSS('* { cursor: none !important; }').catch((error) => {
      logger.error({ error }, 'Failed to hide cursor')
    })
  }
}

/**
 * Handle application crash with bounded exponential backoff
 */
function handleCrash(): void {
  const delay = restartBackoff.getDelay()
  logger.info({ delay, attempt: restartBackoff.getAttempt() }, 'Scheduling restart after crash')

  setTimeout(() => {
    if (mainWindow) {
      mainWindow.destroy()
      mainWindow = null
    }
    createWindow()
  }, delay)
}

/**
 * Initialize all services
 */
async function initializeServices(): Promise<void> {
  logger.info('Initializing services...')

  try {
    // Validate configuration
    const validation = config.validateConfig()
    if (!validation.valid) {
      logger.error({ errors: validation.errors }, 'Invalid configuration')
      throw new Error('Invalid configuration: ' + validation.errors.join(', '))
    }

    await logBackendConnectivity()

    const { getPlayerFlow } = await import('./services/player-flow')
    const playerFlow = getPlayerFlow()

    if (mainWindow) {
      playerFlow.initialize(mainWindow)
    }

    await playerFlow.start()
    logger.info('All services initialized successfully')
  } catch (error) {
    logger.fatal({ error }, 'Failed to initialize services')
    throw error
  }
}

async function logBackendConnectivity(): Promise<void> {
  const appConfig = config.getConfig()
  logger.info(
    {
      apiBase: appConfig.apiBase,
      wsUrl: appConfig.wsUrl,
      deviceId: appConfig.deviceId || 'unpaired',
      configPath: config.getConfigPath(),
    },
    'Resolved backend configuration'
  )

  const networkAddresses = getNetworkAddresses()
  if (networkAddresses.length > 0) {
    logger.info({ addresses: networkAddresses }, 'Detected network interfaces')
  }

  try {
    const { hostname } = new URL(appConfig.apiBase)
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    const isPrivateIp = isPrivateIpv4(hostname)
    logger.info({ hostname, isLocalhost, isPrivateIp }, 'Backend host classification')
  } catch (error) {
    logger.warn({ error, apiBase: appConfig.apiBase }, 'Failed to parse backend URL')
  }

  const { getHttpClient } = await import('./services/network/http-client')
  const httpClient = getHttpClient()
  const result = await httpClient.checkConnectivityDetailed()

  if (result.ok) {
    logger.info({ endpoint: result.endpoint, status: result.status }, 'Backend reachable')
  } else {
    logger.error({ endpoint: result.endpoint, error: result.error }, 'Backend unreachable')
  }
}

function getNetworkAddresses(): string[] {
  const interfaces = os.networkInterfaces()
  const addresses: string[] = []

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        addresses.push(addr.address)
      }
    }
  }

  return addresses
}

function isPrivateIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false
  const [a, b] = hostname.split('.').map((part) => parseInt(part, 10))
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/**
 * Setup IPC handlers
 */
function setupIPCHandlers(): void {
  const { ipcMain } = require('electron')

  // Pairing
  ipcMain.handle('pairing-request', async (_event: any, payload?: any) => {
    const { getPlayerFlow } = await import('./services/player-flow')
    return await getPlayerFlow().requestPairingCode(payload)
  })

  ipcMain.handle('pairing-status', async () => {
    const { getPlayerFlow } = await import('./services/player-flow')
    return await getPlayerFlow().checkPairingStatus()
  })

  ipcMain.handle('pairing-complete', async (_event: any, code?: string) => {
    const { getPlayerFlow } = await import('./services/player-flow')
    return await getPlayerFlow().completePairing(code)
  })

  // Backwards compatibility
  ipcMain.handle('submit-pairing', async (_event: any, code: string) => {
    const { getPlayerFlow } = await import('./services/player-flow')
    return await getPlayerFlow().completePairing(code)
  })

  ipcMain.handle('get-pairing-status', async () => {
    const { getPlayerFlow } = await import('./services/player-flow')
    return await getPlayerFlow().checkPairingStatus()
  })

  ipcMain.handle('request-pairing-code', async (_event: any, payload?: any) => {
    const { getPlayerFlow } = await import('./services/player-flow')
    return await getPlayerFlow().requestPairingCode(payload)
  })

  ipcMain.handle('get-player-status', async () => {
    const { getPlayerFlow } = await import('./services/player-flow')
    return getPlayerFlow().getStatus()
  })

  ipcMain.handle('default-media:get', async (_event: any, options?: { refresh?: boolean }) => {
    const { getDefaultMediaService } = await import('./services/settings/default-media-service')
    return await getDefaultMediaService().getDefaultMedia(options)
  })

  ipcMain.handle('get-player-state', async () => {
    const { getPlayerFlow } = await import('./services/player-flow')
    return getPlayerFlow().getState()
  })

  ipcMain.handle('get-device-info', async () => {
    const { getPairingService } = await import('./services/pairing-service')
    return getPairingService().getDeviceInfo()
  })

  // Diagnostics
  ipcMain.handle('get-diagnostics', async () => {
    const { getPairingService } = await import('./services/pairing-service')
    const { getSnapshotManager } = await import('./services/snapshot-manager')
    const { getRequestQueue } = await import('./services/network/request-queue')
    const { getPlayerFlow } = await import('./services/player-flow')

    const pairingService = getPairingService()
    const snapshotManager = getSnapshotManager()
    const requestQueue = getRequestQueue()
    const playerFlow = getPlayerFlow()

    const diagnostics = await pairingService.runDiagnostics()
    const playlist = snapshotManager.getCurrentPlaylist()

    return {
      deviceId: pairingService.getDeviceId() || 'Not paired',
      ipAddress: diagnostics.ipAddresses.join(', '),
      wsState: 'disconnected',
      lastSync: playlist?.lastSnapshotAt,
      commandQueueSize: requestQueue.getSize(),
      screenMode: 'fullscreen',
      uptime: process.uptime(),
      version: app.getVersion(),
      dnsResolution: diagnostics.dnsResolution,
      apiReachable: diagnostics.apiReachable,
      latency: diagnostics.latency,
      playerState: playerFlow.getState(),
      playbackMode: playerFlow.getStatus().mode,
    }
  })

  // Health
  ipcMain.handle('get-health', async () => {
    // Health server is available but not used directly here
    // This would return health status - simplified for now
    return {
      status: 'healthy',
      appVersion: app.getVersion(),
      uptime: process.uptime(),
    }
  })

  // Renderer logging
  ipcMain.on('renderer-log', (_event: any, { level, message, data }: any) => {
    const rendererLogger = getLogger('renderer')
    rendererLogger[level as keyof typeof rendererLogger](data, message)
  })

  logger.info('IPC handlers setup complete')
}

/**
 * Cleanup on exit
 */
async function cleanup(): Promise<void> {
  logger.info('Cleaning up...')

  try {
    const { getPlayerFlow } = await import('./services/player-flow')
    const { getProofOfPlayService } = await import('./services/pop-service')
    const { getCacheManager } = await import('./services/cache/cache-manager')

    const playerFlow = getPlayerFlow()
    await playerFlow.stop()

    const popService = getProofOfPlayService()
    await popService.cleanup()

    const cacheManager = getCacheManager()
    await cacheManager.cleanup()

    logger.info('Cleanup completed')
  } catch (error) {
    logger.error({ error }, 'Error during cleanup')
  }
}

// ============================================================================
// Application Lifecycle
// ============================================================================

app.on('ready', async () => {
  logger.info({ version: app.getVersion(), electron: process.versions.electron }, 'Application starting')

  try {
    setupIPCHandlers()
    createWindow()
    await initializeServices()
  } catch (error) {
    logger.fatal({ error }, 'Failed to start application')
    app.quit()
  }
})

app.on('window-all-closed', () => {
  // On Linux, keep the app running even if all windows are closed
  // This is important for kiosk mode
  logger.info('All windows closed, but keeping app running')
})

app.on('activate', () => {
  // On macOS, re-create window when dock icon is clicked
  if (mainWindow === null) {
    createWindow()
  }
})

app.on('before-quit', async (event) => {
  event.preventDefault()
  await cleanup()
  app.exit(0)
})

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception')
  // Don't exit immediately, let the app try to recover
})

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection')
})

// Log startup complete
logger.info('Main process initialized')
