/**
 * Main process entry point for HexmonSignage Player
 * Orchestrates all services and manages application lifecycle
 */

console.log('=== HexmonSignage Player Starting ===')
console.log('NODE_ENV:', process.env['NODE_ENV'])
console.log('__dirname:', __dirname)

import { app, BrowserWindow, screen, session } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getConfigManager } from '../common/config'
import { getLogger } from '../common/logger'
import { ExponentialBackoff } from '../common/utils'
import type { AppConfig } from '../common/types'
import { getRuntimeMode, getRuntimeWindowPolicy } from './runtime-mode'

console.log('Initializing logger...')
const logger = getLogger('main')
console.log('Logger initialized')
const config = getConfigManager()

config.onChange((nextConfig) => {
  applyConfigToNetworkClients(nextConfig)
  broadcastConfigUpdate(nextConfig)
})

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
const WEBPAGE_PARTITION = 'persist:hexmon-webpage-playback'

function isSafeWebpageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function configureWebpageSession(): void {
  const webpageSession = session.fromPartition(WEBPAGE_PARTITION)
  webpageSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}

function broadcastConfigUpdate(nextConfig?: AppConfig): void {
  const payload = nextConfig || config.getConfig()
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send('config:changed', payload)
    }
  })
}

function applyConfigToNetworkClients(nextConfig: AppConfig): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getHttpClient } = require('./services/network/http-client')
    const httpClient = getHttpClient()
    if (typeof httpClient.applyConfig === 'function') {
      httpClient.applyConfig(nextConfig)
    } else if (typeof httpClient.setBaseURL === 'function') {
      httpClient.setBaseURL(nextConfig.apiBase)
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to apply config to HTTP client')
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getWebSocketClient } = require('./services/network/websocket-client')
    const wsClient = getWebSocketClient()
    if (typeof wsClient.applyConfig === 'function') {
      wsClient.applyConfig(nextConfig)
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to apply config to WebSocket client')
  }
}

// Disable hardware acceleration if needed for stability
// app.disableHardwareAcceleration()

function applyRuntimeInteractionPolicy(window: BrowserWindow, appConfig: AppConfig): void {
  const mode = getRuntimeMode(appConfig)
  const policy = getRuntimeWindowPolicy(mode)

  if (policy.disableInput) {
    window.setMenuBarVisibility(false)
    window.removeMenu()
    window.webContents.setIgnoreMenuShortcuts(true)
    window.webContents.on('before-input-event', (event) => {
      event.preventDefault()
    })
  }

  const shouldHideCursor = policy.hideCursor || process.env['HEXMON_HIDE_CURSOR'] === 'true'
  if (shouldHideCursor) {
    const pointerRules = policy.disableInput ? 'pointer-events: none !important;' : ''
    window.webContents
      .insertCSS(`
        * {
          cursor: none !important;
          ${pointerRules}
        }
      `)
      .catch((error) => {
        logger.error({ error, mode }, 'Failed to apply runtime interaction policy')
      })
  }
}

/**
 * Create the main browser window using the configured runtime mode.
 */
function createWindow(): void {
  const appConfig = config.getConfig()
  const mode = getRuntimeMode(appConfig)
  const windowPolicy = getRuntimeWindowPolicy(mode)
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize
  const windowWidth = windowPolicy.kiosk ? width : Math.min(width, 1440)
  const windowHeight = windowPolicy.kiosk ? height : Math.min(height, 900)

  logger.info({ width: windowWidth, height: windowHeight, mode, kiosk: windowPolicy.kiosk }, 'Creating main window')

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    center: true,
    fullscreen: windowPolicy.fullscreen,
    kiosk: windowPolicy.kiosk,
    frame: windowPolicy.frame,
    movable: windowPolicy.movable,
    resizable: windowPolicy.resizable,
    minimizable: windowPolicy.minimizable,
    maximizable: windowPolicy.maximizable,
    closable: windowPolicy.closable,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '../../renderer/preload/index.js'),
      nodeIntegration: appConfig.security.nodeIntegration,
      contextIsolation: appConfig.security.contextIsolation,
      sandbox: appConfig.security.sandbox,
      webviewTag: true,
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

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const targetUrl = typeof params['src'] === 'string' ? params['src'] : ''
    if (!isSafeWebpageUrl(targetUrl)) {
      logger.warn({ url: targetUrl }, 'Prevented unsafe webpage playback URL')
      event.preventDefault()
      return
    }

    params['partition'] = WEBPAGE_PARTITION
    params['allowpopups'] = 'false'
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
  })

  applyRuntimeInteractionPolicy(mainWindow, appConfig)
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

    const { getPlayerFlow } = await import('./services/player-flow.js')
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

  const { getHttpClient } = await import('./services/network/http-client.js')
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
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  const a = parseInt(parts[0] || '', 10)
  const b = parseInt(parts[1] || '', 10)
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

  ipcMain.handle('config:get', async () => config.getConfig())

  ipcMain.handle('config:set', async (_event: any, updates: Partial<AppConfig>) => {
    config.updateConfig(updates || {})
    return config.getConfig()
  })

  ipcMain.handle('get-config', async () => config.getConfig())

  ipcMain.handle('update-config', async (_event: any, updates: Partial<AppConfig>) => {
    config.updateConfig(updates || {})
    return config.getConfig()
  })

  // Pairing
  ipcMain.handle('pairing-request', async (_event: any, payload?: any) => {
    const { getPlayerFlow } = await import('./services/player-flow.js')
    return await getPlayerFlow().requestPairingCode(payload)
  })

  ipcMain.handle('pairing-status', async () => {
    const { getPlayerFlow } = await import('./services/player-flow.js')
    return await getPlayerFlow().checkPairingStatus()
  })

  ipcMain.handle('pairing-complete', async (_event: any, code?: string) => {
    const { getPlayerFlow } = await import('./services/player-flow.js')
    void code
    return await getPlayerFlow().completePairing()
  })

  // Backwards compatibility
  ipcMain.handle('submit-pairing', async (_event: any, code: string) => {
    const { getPlayerFlow } = await import('./services/player-flow.js')
    void code
    return await getPlayerFlow().completePairing()
  })

  ipcMain.handle('get-pairing-status', async () => {
    const { getPlayerFlow } = await import('./services/player-flow.js')
    return await getPlayerFlow().checkPairingStatus()
  })

  ipcMain.handle('request-pairing-code', async (_event: any, payload?: any) => {
    const { getPlayerFlow } = await import('./services/player-flow.js')
    return await getPlayerFlow().requestPairingCode(payload)
  })

  ipcMain.handle('player-action', async (_event: any, action: string, payload?: any) => {
    const { getPlayerFlow } = await import('./services/player-flow.js')
    if (action === 'retry-recovery' || action === 're-pair' || action === 'reset-doubtful-pairing' || action === 'refresh-pairing') {
      await getPlayerFlow().performAction(action, payload)
      return getPlayerFlow().getStatus()
    }
    throw new Error(`Unsupported player action: ${action}`)
  })

  ipcMain.handle('get-player-status', async () => {
    const { getPlayerFlow } = await import('./services/player-flow.js')
    return getPlayerFlow().getStatus()
  })

  ipcMain.handle('default-media:get', async (_event: any, options?: { refresh?: boolean }) => {
    const { getDefaultMediaService } = await import('./services/settings/default-media-service.js')
    return await getDefaultMediaService().getDefaultMedia(options)
  })

  ipcMain.handle('get-player-state', async () => {
    const { getPlayerFlow } = await import('./services/player-flow.js')
    return getPlayerFlow().getState()
  })

  ipcMain.handle('get-device-info', async () => {
    const { getPairingService } = await import('./services/pairing-service.js')
    return getPairingService().getDeviceInfo()
  })

  // Diagnostics
  ipcMain.handle('get-diagnostics', async () => {
    const { getPairingService } = await import('./services/pairing-service.js')
    const { getSnapshotManager } = await import('./services/snapshot-manager.js')
    const { getRequestQueue } = await import('./services/network/request-queue.js')
    const { getPlayerFlow } = await import('./services/player-flow.js')

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
      screenMode: config.getConfig().runtime.mode,
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
    const { getPlayerFlow } = await import('./services/player-flow.js')
    const { getProofOfPlayService } = await import('./services/pop-service.js')
    const { getCacheManager } = await import('./services/cache/cache-manager.js')

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
    configureWebpageSession()
    setupIPCHandlers()
    createWindow()
    await initializeServices()
  } catch (error) {
    logger.fatal({ error }, 'Failed to start application')
    app.quit()
  }
})

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') {
    return
  }

  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!isSafeWebpageUrl(url)) {
      logger.warn({ url }, 'Blocked unsafe webview navigation')
      event.preventDefault()
    }
  })
})

app.on('window-all-closed', () => {
  // On Linux, keep the app running even if all windows are closed
  // This is important for unattended signage runtime
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
