/**
 * System Stats - Collect CPU, RAM, disk, network, and temperature stats
 */

import * as os from 'os'
import * as fs from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { getLogger } from '../../../common/logger'
import { DisplayTelemetry, NetworkInterface, PowerSource, SystemStats } from '../../../common/types'
import { getDiskUsage } from '../../../common/utils'

const execAsync = promisify(exec)
const logger = getLogger('system-stats')

export class SystemStatsCollector {
  private lastCpuUsage: { idle: number; total: number } | null = null

  /**
   * Collect all system stats
   */
  async collect(): Promise<SystemStats> {
    const [cpuUsage, memoryUsage, diskUsage, temperature, networkInterfaces, displays, battery] = await Promise.all([
      this.getCPUUsage(),
      this.getMemoryUsage(),
      this.getDiskUsage(),
      this.getTemperature(),
      this.getNetworkInterfaces(),
      this.getDisplays(),
      this.getBatteryInfo(),
    ])

    const [cpuLoad1m = 0, cpuLoad5m = 0, cpuLoad15m = 0] = this.getLoadAverage()
    const primaryNetwork = this.getPrimaryNetworkInterface(networkInterfaces)
    const platformInfo = this.getPlatformInfo()

    return {
      cpuUsage,
      cpuCores: os.cpus().length,
      cpuLoad1m,
      cpuLoad5m,
      cpuLoad15m,
      memoryUsage: memoryUsage.used,
      memoryTotal: memoryUsage.total,
      memoryFree: memoryUsage.free,
      diskUsage: diskUsage.used,
      diskTotal: diskUsage.total,
      diskFree: diskUsage.free,
      temperature,
      uptime: os.uptime(),
      networkInterfaces,
      primaryNetworkInterface: primaryNetwork?.name,
      primaryNetworkAddress: primaryNetwork?.address,
      displayCount: displays.length,
      displays,
      hostname: platformInfo.hostname,
      osVersion: `${platformInfo.platform} ${platformInfo.release}`,
      batteryPercent: battery?.batteryPercent,
      isCharging: battery?.isCharging,
      powerSource: battery?.powerSource,
    }
  }

  /**
   * Get CPU usage percentage
   */
  async getCPUUsage(): Promise<number> {
    const cpus = os.cpus()
    let idle = 0
    let total = 0

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        total += cpu.times[type as keyof typeof cpu.times]
      }
      idle += cpu.times.idle
    }

    if (this.lastCpuUsage) {
      const idleDiff = idle - this.lastCpuUsage.idle
      const totalDiff = total - this.lastCpuUsage.total
      const usage = 100 - (100 * idleDiff) / totalDiff
      this.lastCpuUsage = { idle, total }
      return Math.round(usage * 100) / 100
    }

    this.lastCpuUsage = { idle, total }
    return 0
  }

  /**
   * Get memory usage
   */
  getMemoryUsage(): { used: number; total: number; free: number } {
    const total = os.totalmem()
    const free = os.freemem()
    const used = total - free

    return { used, total, free }
  }

  /**
   * Get disk usage
   */
  async getDiskUsage(): Promise<{ used: number; total: number; free: number }> {
    try {
      const homedir = os.homedir()
      return await getDiskUsage(homedir)
    } catch (error) {
      logger.error({ error }, 'Failed to get disk usage')
      return { used: 0, total: 0, free: 0 }
    }
  }

  /**
   * Get CPU temperature (Linux only)
   */
  async getTemperature(): Promise<number | undefined> {
    if (os.platform() !== 'linux') {
      return undefined
    }

    try {
      // Try reading from thermal zone
      const thermalPath = '/sys/class/thermal/thermal_zone0/temp'
      if (fs.existsSync(thermalPath)) {
        const temp = fs.readFileSync(thermalPath, 'utf-8')
        return parseInt(temp, 10) / 1000 // Convert from millidegrees
      }

      // Try using sensors command
      const { stdout } = await execAsync('sensors -u 2>/dev/null | grep temp1_input | head -1 | awk \'{print $2}\'')
      const temp = parseFloat(stdout.trim())
      if (!isNaN(temp)) {
        return temp
      }
    } catch (error) {
      logger.debug({ error }, 'Failed to get temperature')
    }

    return undefined
  }

  /**
   * Get network interfaces
   */
  getNetworkInterfaces(): NetworkInterface[] {
    const interfaces = os.networkInterfaces()
    const result: NetworkInterface[] = []

    for (const name of Object.keys(interfaces)) {
      const iface = interfaces[name]
      if (!iface) continue

      for (const addr of iface) {
        result.push({
          name,
          address: addr.address,
          netmask: addr.netmask,
          family: addr.family as 'IPv4' | 'IPv6',
          internal: addr.internal,
        })
      }
    }

    return result
  }

  getPrimaryNetworkInterface(networkInterfaces: NetworkInterface[]): NetworkInterface | undefined {
    return (
      networkInterfaces.find((iface) => !iface.internal && iface.family === 'IPv4') ??
      networkInterfaces.find((iface) => !iface.internal) ??
      networkInterfaces[0]
    )
  }

  async getDisplays(): Promise<DisplayTelemetry[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { screen } = require('electron') as typeof import('electron')
      if (!screen || typeof screen.getAllDisplays !== 'function') {
        return []
      }

      return screen.getAllDisplays().map((display) => ({
        id: String(display.id),
        width: display.bounds.width,
        height: display.bounds.height,
        refresh_rate_hz:
          typeof display.displayFrequency === 'number' && Number.isFinite(display.displayFrequency)
            ? display.displayFrequency
            : undefined,
        orientation: display.rotation === 90 || display.rotation === 270 ? 'portrait' : 'landscape',
        connected: true,
        model: display.label || undefined,
      }))
    } catch (error) {
      logger.debug({ error }, 'Failed to get display information')
      return []
    }
  }

  async getBatteryInfo(): Promise<
    | {
        batteryPercent?: number
        isCharging?: boolean
        powerSource?: PowerSource
      }
    | undefined
  > {
    try {
      if (os.platform() === 'linux') {
        return await this.getLinuxBatteryInfo()
      }

      if (os.platform() === 'darwin') {
        return await this.getMacBatteryInfo()
      }
    } catch (error) {
      logger.debug({ error }, 'Failed to get battery information')
    }

    return undefined
  }

  private async getLinuxBatteryInfo(): Promise<
    | {
        batteryPercent?: number
        isCharging?: boolean
        powerSource?: PowerSource
      }
    | undefined
  > {
    const powerSupplyDir = '/sys/class/power_supply'
    if (!fs.existsSync(powerSupplyDir)) {
      return undefined
    }

    const entries = fs.readdirSync(powerSupplyDir)
    const batteryDir = entries.find((entry) => entry.startsWith('BAT'))
    const acDir = entries.find((entry) => /^(AC|ACAD|Mains)/i.test(entry))

    const readValue = (dir: string | undefined, fileName: string) => {
      if (!dir) return undefined
      const filePath = `${powerSupplyDir}/${dir}/${fileName}`
      if (!fs.existsSync(filePath)) return undefined
      return fs.readFileSync(filePath, 'utf-8').trim()
    }

    const percentRaw = readValue(batteryDir, 'capacity')
    const statusRaw = readValue(batteryDir, 'status')?.toLowerCase()
    const acOnlineRaw = readValue(acDir, 'online')

    const parsedPercent = percentRaw ? Number(percentRaw) : undefined
    const batteryPercent = typeof parsedPercent === 'number' && Number.isFinite(parsedPercent) ? parsedPercent : undefined
    const isCharging =
      statusRaw === 'charging' ? true : statusRaw === 'discharging' ? false : statusRaw === 'full' ? false : undefined
    const powerSource: PowerSource | undefined =
      statusRaw === 'discharging'
        ? 'BATTERY'
        : acOnlineRaw === '1' || statusRaw === 'charging' || statusRaw === 'full'
          ? 'AC'
          : batteryDir
            ? 'BATTERY'
            : undefined

    if (batteryPercent === undefined && isCharging === undefined && powerSource === undefined) {
      return undefined
    }

    return {
      batteryPercent,
      isCharging,
      powerSource,
    }
  }

  private async getMacBatteryInfo(): Promise<
    | {
        batteryPercent?: number
        isCharging?: boolean
        powerSource?: PowerSource
      }
    | undefined
  > {
    const { stdout } = await execAsync('pmset -g batt')
    const percentMatch = stdout.match(/(\d+)%/)
    const status = stdout.toLowerCase()

    const parsedPercent = percentMatch ? Number(percentMatch[1]) : undefined
    const batteryPercent = typeof parsedPercent === 'number' && Number.isFinite(parsedPercent) ? parsedPercent : undefined
    const isCharging = status.includes('charging') ? true : status.includes('discharging') ? false : undefined
    const powerSource: PowerSource | undefined =
      status.includes('ac power') || status.includes('charging')
        ? 'AC'
        : status.includes('battery power') || status.includes('discharging')
          ? 'BATTERY'
          : undefined

    if (batteryPercent === undefined && isCharging === undefined && powerSource === undefined) {
      return undefined
    }

    return {
      batteryPercent,
      isCharging,
      powerSource,
    }
  }

  /**
   * Get load average (Unix only)
   */
  getLoadAverage(): number[] {
    return os.loadavg()
  }

  /**
   * Get platform info
   */
  getPlatformInfo(): {
    platform: string
    arch: string
    release: string
    hostname: string
  } {
    return {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
    }
  }
}

// Singleton instance
let statsCollector: SystemStatsCollector | null = null

export function getSystemStatsCollector(): SystemStatsCollector {
  if (!statsCollector) {
    statsCollector = new SystemStatsCollector()
  }
  return statsCollector
}
