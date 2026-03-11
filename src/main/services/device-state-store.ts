import * as fs from 'fs'
import * as path from 'path'
import { EventEmitter } from 'events'
import { getConfigManager } from '../../common/config'
import { DeviceStateRecord, PlayerState, RecentCommandRecord } from '../../common/types'
import { atomicWrite, ensureDir } from '../../common/utils'
import { getLogger } from '../../common/logger'

const logger = getLogger('device-state-store')

const MAX_RECENT_COMMANDS = 200
const RECENT_COMMAND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface IdentitySnapshot {
  deviceIdPresent: boolean
  fingerprintPresent: boolean
  keyPresent: boolean
  certPresent: boolean
  caPresent: boolean
}

export type IdentityHealth = 'missing' | 'partial' | 'complete'

export class DeviceStateStore {
  private readonly statePath: string
  private state: DeviceStateRecord
  private readonly emitter = new EventEmitter()

  constructor(statePath?: string) {
    this.statePath = statePath || this.getDefaultStatePath()
    this.state = this.loadState()
  }

  private getDefaultStatePath(): string {
    const configPath = getConfigManager().getConfigPath()
    return path.join(path.dirname(configPath), 'device-state.json')
  }

  private loadState(): DeviceStateRecord {
    try {
      if (!fs.existsSync(this.statePath)) {
        return {}
      }

      const raw = fs.readFileSync(this.statePath, 'utf-8')
      const parsed = JSON.parse(raw) as DeviceStateRecord
      return {
        ...parsed,
        recentCommands: Array.isArray(parsed.recentCommands) ? parsed.recentCommands : [],
      }
    } catch (error) {
      logger.error({ error, statePath: this.statePath }, 'Failed to load device state')
      return {}
    }
  }

  private async persist(): Promise<void> {
    ensureDir(path.dirname(this.statePath), 0o755)
    await atomicWrite(this.statePath, JSON.stringify(this.state, null, 2))
  }

  getState(): DeviceStateRecord {
    return {
      ...this.state,
      recentCommands: [...(this.state.recentCommands || [])],
    }
  }

  async update(patch: Partial<DeviceStateRecord>): Promise<DeviceStateRecord> {
    this.state = {
      ...this.state,
      ...patch,
      recentCommands: patch.recentCommands ? [...patch.recentCommands] : [...(this.state.recentCommands || [])],
    }

    await this.persist()
    this.emitter.emit('change', this.getState())
    return this.getState()
  }

  async clearPairingMetadata(): Promise<DeviceStateRecord> {
    return await this.update({
      pairingCode: undefined,
      pairingExpiresAt: undefined,
      activePairingMode: undefined,
      pairingRequestInDoubtAt: undefined,
    })
  }

  async clearIdentity(reason?: string): Promise<DeviceStateRecord> {
    return await this.update({
      lifecycleState: undefined,
      deviceId: undefined,
      pairingCode: undefined,
      pairingExpiresAt: undefined,
      activePairingMode: undefined,
      fingerprint: undefined,
      lastSuccessfulPairingAt: undefined,
      lastHeartbeatAt: undefined,
      recoveryReason: reason,
      hardRecoveryDeadlineAt: undefined,
      pairingRequestInDoubtAt: undefined,
      recentCommands: [],
    })
  }

  async setLifecycleState(state: PlayerState, extras: Partial<DeviceStateRecord> = {}): Promise<DeviceStateRecord> {
    return await this.update({
      ...extras,
      lifecycleState: state,
    })
  }

  async recordCommandSeen(commandId: string, source: 'heartbeat' | 'poll'): Promise<void> {
    const now = new Date().toISOString()
    const current = this.state.recentCommands || []
    const existingIndex = current.findIndex((entry) => entry.id === commandId)
    let next: RecentCommandRecord[]

    if (existingIndex >= 0) {
      next = current.map((entry, index) =>
        index === existingIndex
          ? {
              ...entry,
              lastSeenAt: now,
              source,
            }
          : entry
      )
    } else {
      next = [
        ...current,
        {
          id: commandId,
          firstSeenAt: now,
          lastSeenAt: now,
          source,
        },
      ]
    }

    await this.update({
      recentCommands: this.pruneRecentCommands(next),
    })
  }

  async recordCommandAcknowledged(commandId: string): Promise<void> {
    const now = new Date().toISOString()
    const next = (this.state.recentCommands || []).map((entry) =>
      entry.id === commandId
        ? {
            ...entry,
            acknowledgedAt: now,
            lastSeenAt: now,
          }
        : entry
    )

    await this.update({
      recentCommands: this.pruneRecentCommands(next),
    })
  }

  hasRecentCommand(commandId: string): boolean {
    return (this.state.recentCommands || []).some((entry) => entry.id === commandId)
  }

  getIdentitySnapshot(paths: { key: string; cert: string; ca: string }): IdentitySnapshot {
    return {
      deviceIdPresent: Boolean(this.state.deviceId),
      fingerprintPresent: Boolean(this.state.fingerprint),
      keyPresent: fs.existsSync(paths.key),
      certPresent: fs.existsSync(paths.cert),
      caPresent: fs.existsSync(paths.ca),
    }
  }

  classifyIdentity(snapshot: IdentitySnapshot): { health: IdentityHealth; issues: string[] } {
    const issues: string[] = []

    if (snapshot.deviceIdPresent && !snapshot.keyPresent) {
      issues.push('Persisted device id exists but private key is missing')
    }
    if (snapshot.keyPresent && !snapshot.certPresent) {
      issues.push('Private key exists but certificate is missing')
    }
    if (snapshot.certPresent && !snapshot.fingerprintPresent) {
      issues.push('Certificate exists but fingerprint is missing')
    }
    if (snapshot.fingerprintPresent && !snapshot.certPresent) {
      issues.push('Fingerprint exists but certificate is missing')
    }
    if ((snapshot.certPresent || snapshot.caPresent) && !snapshot.keyPresent) {
      issues.push('Certificate material exists but private key is missing')
    }

    const presentValues = [
      snapshot.deviceIdPresent,
      snapshot.fingerprintPresent,
      snapshot.keyPresent,
      snapshot.certPresent,
      snapshot.caPresent,
    ]
    const anyPresent = presentValues.some(Boolean)
    const allPresent = presentValues.every(Boolean)

    if (allPresent) {
      return { health: 'complete', issues }
    }
    if (anyPresent) {
      return { health: 'partial', issues: issues.length > 0 ? issues : ['Device identity is incomplete'] }
    }
    return { health: 'missing', issues: [] }
  }

  onChange(listener: (state: DeviceStateRecord) => void): () => void {
    this.emitter.on('change', listener)
    return () => this.emitter.off('change', listener)
  }

  private pruneRecentCommands(entries: RecentCommandRecord[]): RecentCommandRecord[] {
    const cutoff = Date.now() - RECENT_COMMAND_RETENTION_MS
    const filtered = entries.filter((entry) => {
      const lastSeen = Date.parse(entry.lastSeenAt)
      return !Number.isNaN(lastSeen) && lastSeen >= cutoff
    })

    if (filtered.length <= MAX_RECENT_COMMANDS) {
      return filtered
    }

    return filtered.slice(filtered.length - MAX_RECENT_COMMANDS)
  }
}

let deviceStateStore: DeviceStateStore | null = null

export function getDeviceStateStore(): DeviceStateStore {
  if (!deviceStateStore) {
    deviceStateStore = new DeviceStateStore()
  }
  return deviceStateStore
}

export function resetDeviceStateStore(): void {
  deviceStateStore = null
}
