/**
 * Power Manager - Display power management and DPMS control
 * Linux-specific features with Windows stubs for cross-platform compatibility
 */

import * as os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import { powerSaveBlocker } from 'electron'
import { getLogger } from '../../common/logger'
import { findExecutable } from '../../common/utils'

const execAsync = promisify(exec)
const logger = getLogger('power-manager')

export interface DisplayInfo {
  name: string
  connected: boolean
  resolution?: string
  primary?: boolean
}

export interface PowerSchedule {
  onTime?: string // HH:MM format
  offTime?: string // HH:MM format
  enabled: boolean
}

export interface PowerCapabilities {
  platform: NodeJS.Platform
  dpmsControl: boolean
  preventBlanking: boolean
  displayEnumeration: boolean
}

export class PowerManager {
  private isLinux: boolean
  private readonly xsetPath: string | null
  private powerSaveBlockerId?: number
  private scheduleTimer?: NodeJS.Timeout
  private currentSchedule?: PowerSchedule

  constructor() {
    this.isLinux = os.platform() === 'linux'
    this.xsetPath = this.isLinux ? findExecutable('xset') : null
    logger.info(
      {
        platform: os.platform(),
        isLinux: this.isLinux,
        xsetAvailable: Boolean(this.xsetPath),
      },
      'Power manager initialized'
    )
  }

  getCapabilities(): PowerCapabilities {
    return {
      platform: os.platform(),
      dpmsControl: Boolean(this.xsetPath),
      preventBlanking: Boolean(this.xsetPath),
      displayEnumeration: true,
    }
  }

  /**
   * Initialize power manager
   */
  async initialize(): Promise<void> {
    logger.info('Initializing power manager')

    try {
      // Prevent screen blanking
      await this.preventScreenBlanking()

      // Disable DPMS (Linux only)
      if (this.isLinux) {
        await this.disableDPMS()
      }

      // Block power save
      this.blockPowerSave()

      logger.info('Power manager initialized successfully')
    } catch (error) {
      logger.error({ error }, 'Failed to initialize power manager')
      throw error
    }
  }

  /**
   * Prevent screen blanking
   */
  private async preventScreenBlanking(): Promise<void> {
    if (!this.isLinux || !this.xsetPath) {
      logger.debug('Screen blanking prevention not available on this platform')
      return
    }

    try {
      // Disable screen saver
      await execAsync(`${this.xsetPath} s off`)
      logger.info('Screen saver disabled')

      // Disable screen blanking
      await execAsync(`${this.xsetPath} s noblank`)
      logger.info('Screen blanking disabled')
    } catch (error) {
      logger.warn({ error }, 'Failed to prevent screen blanking (xset may not be available)')
    }
  }

  /**
   * Disable DPMS (Display Power Management Signaling)
   */
  private async disableDPMS(): Promise<void> {
    if (!this.isLinux || !this.xsetPath) {
      logger.debug('DPMS control not available on this platform')
      return
    }

    try {
      await execAsync(`${this.xsetPath} -dpms`)
      logger.info('DPMS disabled')
    } catch (error) {
      logger.warn({ error }, 'Failed to disable DPMS (xset may not be available)')
    }
  }

  /**
   * Enable DPMS
   */
  async enableDPMS(): Promise<void> {
    if (!this.isLinux || !this.xsetPath) {
      logger.debug('DPMS control not available on this platform')
      return
    }

    try {
      await execAsync(`${this.xsetPath} +dpms`)
      logger.info('DPMS enabled')
    } catch (error) {
      logger.error({ error }, 'Failed to enable DPMS')
      throw error
    }
  }

  /**
   * Block power save using Electron's powerSaveBlocker
   */
  private blockPowerSave(): void {
    if (this.powerSaveBlockerId !== undefined) {
      logger.debug('Power save already blocked')
      return
    }

    try {
      this.powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep')
      logger.info({ blockerId: this.powerSaveBlockerId }, 'Power save blocked')
    } catch (error) {
      logger.error({ error }, 'Failed to block power save')
    }
  }

  /**
   * Unblock power save
   */
  private unblockPowerSave(): void {
    if (this.powerSaveBlockerId === undefined) {
      return
    }

    try {
      powerSaveBlocker.stop(this.powerSaveBlockerId)
      logger.info({ blockerId: this.powerSaveBlockerId }, 'Power save unblocked')
      this.powerSaveBlockerId = undefined
    } catch (error) {
      logger.error({ error }, 'Failed to unblock power save')
    }
  }

  /**
   * Turn display on
   */
  async turnDisplayOn(): Promise<void> {
    logger.info('Turning display on')

    if (!this.isLinux || !this.xsetPath) {
      logger.debug('Display control not available on this platform')
      return
    }

    try {
      // Force display on using xset
      await execAsync(`${this.xsetPath} dpms force on`)
      logger.info('Display turned on')
    } catch (error) {
      logger.error({ error }, 'Failed to turn display on')
      throw error
    }
  }

  /**
   * Turn display off
   */
  async turnDisplayOff(): Promise<void> {
    logger.info('Turning display off')

    if (!this.isLinux || !this.xsetPath) {
      logger.debug('Display control not available on this platform')
      return
    }

    try {
      // Force display off using xset
      await execAsync(`${this.xsetPath} dpms force off`)
      logger.info('Display turned off')
    } catch (error) {
      logger.error({ error }, 'Failed to turn display off')
      throw error
    }
  }

  /**
   * Get display information
   */
  async getDisplayInfo(): Promise<DisplayInfo[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { screen } = require('electron') as typeof import('electron')
      if (!screen || typeof screen.getAllDisplays !== 'function') {
        logger.debug('Electron screen API not available')
        return []
      }

      const primaryId = screen.getPrimaryDisplay()?.id
      const displays = screen.getAllDisplays().map((display) => ({
        name: display.label || `Display ${display.id}`,
        connected: true,
        resolution: `${display.bounds.width}x${display.bounds.height}`,
        primary: display.id === primaryId,
      }))
      logger.debug({ displays }, 'Display information retrieved')
      return displays
    } catch (error) {
      logger.error({ error }, 'Failed to get display information')
      return []
    }
  }

  /**
   * Set power schedule
   */
  setSchedule(schedule: PowerSchedule): void {
    logger.info({ schedule }, 'Setting power schedule')

    this.currentSchedule = schedule

    // Clear existing timer
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer)
      this.scheduleTimer = undefined
    }

    if (!schedule.enabled) {
      logger.info('Power schedule disabled')
      return
    }

    // Schedule next action
    this.scheduleNextAction()
  }

  /**
   * Schedule next power action
   */
  private scheduleNextAction(): void {
    if (!this.currentSchedule || !this.currentSchedule.enabled) {
      return
    }

    const now = new Date()
    const { onTime, offTime } = this.currentSchedule

    let nextAction: 'on' | 'off' | null = null
    let nextTime: Date | null = null

    // Parse times
    if (onTime) {
      const timeParts = onTime.split(':').map(Number)
      const hours = timeParts[0]
      const minutes = timeParts[1]
      if (hours !== undefined && minutes !== undefined) {
        const onDate = new Date(now)
        onDate.setHours(hours, minutes, 0, 0)

        if (onDate > now) {
          nextAction = 'on'
          nextTime = onDate
        }
      }
    }

    if (offTime) {
      const timeParts = offTime.split(':').map(Number)
      const hours = timeParts[0]
      const minutes = timeParts[1]
      if (hours !== undefined && minutes !== undefined) {
        const offDate = new Date(now)
        offDate.setHours(hours, minutes, 0, 0)

        if (offDate > now && (!nextTime || offDate < nextTime)) {
          nextAction = 'off'
          nextTime = offDate
        }
      }
    }

    // If no action today, schedule for tomorrow
    if (!nextTime && (onTime || offTime)) {
      const tomorrow = new Date(now)
      tomorrow.setDate(tomorrow.getDate() + 1)

      if (onTime) {
        const timeParts = onTime.split(':').map(Number)
        const hours = timeParts[0]
        const minutes = timeParts[1]
        if (hours !== undefined && minutes !== undefined) {
          tomorrow.setHours(hours, minutes, 0, 0)
          nextAction = 'on'
          nextTime = tomorrow
        }
      }
    }

    if (nextTime && nextAction) {
      const delay = nextTime.getTime() - now.getTime()
      logger.info({ nextAction, nextTime: nextTime.toISOString(), delayMs: delay }, 'Scheduling next power action')

      this.scheduleTimer = setTimeout(() => {
        this.executePowerAction(nextAction!)
        this.scheduleNextAction() // Schedule next action
      }, delay)
    }
  }

  /**
   * Execute power action
   */
  private async executePowerAction(action: 'on' | 'off'): Promise<void> {
    logger.info({ action }, 'Executing power action')

    try {
      if (action === 'on') {
        await this.turnDisplayOn()
      } else {
        await this.turnDisplayOff()
      }
    } catch (error) {
      logger.error({ error, action }, 'Failed to execute power action')
    }
  }

  /**
   * Get current schedule
   */
  getSchedule(): PowerSchedule | undefined {
    return this.currentSchedule
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    logger.info('Cleaning up power manager')

    // Clear schedule timer
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer)
      this.scheduleTimer = undefined
    }

    // Unblock power save
    this.unblockPowerSave()
  }
}

// Singleton instance
let powerManager: PowerManager | null = null

export function getPowerManager(): PowerManager {
  if (!powerManager) {
    powerManager = new PowerManager()
  }
  return powerManager
}
