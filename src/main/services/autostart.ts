import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getLogger } from '../../common/logger'
import { getConfigManager } from '../../common/config'
import { getElectronApp } from '../../common/platform-paths'

const logger = getLogger('autostart')
const AUTOSTART_DESKTOP_ENTRY = 'hexmon-signage-player.desktop'

export interface AutostartStatus {
  supported: boolean
  enabled: boolean
  strategy: 'windows-login-item' | 'linux-xdg-autostart' | 'unsupported'
  targetPath?: string
  reason?: string
}

function shouldManageAutostart() {
  if (process.env['HEXMON_AUTOSTART_ENABLED'] === 'false') {
    return false
  }

  return getConfigManager().getConfig().runtime.mode !== 'dev'
}

function resolveExecPath() {
  if (os.platform() === 'linux' && process.env['APPIMAGE']) {
    return process.env['APPIMAGE']
  }

  return process.execPath
}

function getLinuxDesktopEntryPath() {
  const homeDir = getElectronApp()?.getPath('home') || os.homedir()
  return path.join(homeDir, '.config', 'autostart', AUTOSTART_DESKTOP_ENTRY)
}

function quoteExecPath(executable: string) {
  return executable.includes(' ') ? `"${executable}"` : executable
}

function buildLinuxDesktopEntry() {
  const executable = quoteExecPath(resolveExecPath())
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=HexmonSignage Player',
    'Comment=Hexmon digital signage player',
    `Exec=${executable}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupNotify=false',
    'Categories=Utility;',
    '',
  ].join('\n')
}

export function getAutostartStatus(): AutostartStatus {
  if (os.platform() === 'win32') {
    const electronApp = getElectronApp()
    if (!electronApp || typeof electronApp.getLoginItemSettings !== 'function') {
      return {
        supported: false,
        enabled: false,
        strategy: 'unsupported',
        reason: 'Windows autostart inspection requires the Electron runtime',
      }
    }

    const settings = electronApp.getLoginItemSettings()
    return {
      supported: true,
      enabled: Boolean(settings.openAtLogin),
      strategy: 'windows-login-item',
      targetPath: resolveExecPath(),
    }
  }

  if (os.platform() === 'linux') {
    const targetPath = getLinuxDesktopEntryPath()
    return {
      supported: true,
      enabled: fs.existsSync(targetPath),
      strategy: 'linux-xdg-autostart',
      targetPath,
    }
  }

  return {
    supported: false,
    enabled: false,
    strategy: 'unsupported',
    reason: 'Autostart is only managed for Windows and Linux session installs',
  }
}

export async function ensureAutostartRegistration(): Promise<AutostartStatus> {
  const enabled = shouldManageAutostart()
  const electronApp = getElectronApp()

  if (os.platform() === 'win32') {
    if (!electronApp || typeof electronApp.setLoginItemSettings !== 'function') {
      return getAutostartStatus()
    }

    electronApp.setLoginItemSettings({
      openAtLogin: enabled,
      path: resolveExecPath(),
    })
    const status = getAutostartStatus()
    logger.info({ enabled: status.enabled, strategy: status.strategy }, 'Updated autostart registration')
    return status
  }

  if (os.platform() === 'linux') {
    const targetPath = getLinuxDesktopEntryPath()
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 })

    if (enabled) {
      fs.writeFileSync(targetPath, buildLinuxDesktopEntry(), { mode: 0o644 })
    } else if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { force: true })
    }

    const status = getAutostartStatus()
    logger.info({ enabled: status.enabled, strategy: status.strategy, targetPath }, 'Updated autostart registration')
    return status
  }

  const status = getAutostartStatus()
  logger.info({ strategy: status.strategy }, 'Autostart management skipped on unsupported platform')
  return status
}
