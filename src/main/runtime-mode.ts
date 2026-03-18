import type { AppConfig, RuntimeMode } from '../common/types'

export interface RuntimeWindowPolicy {
  mode: RuntimeMode
  fullscreen: boolean
  kiosk: boolean
  frame: boolean
  movable: boolean
  resizable: boolean
  minimizable: boolean
  maximizable: boolean
  closable: boolean
  hideCursor: boolean
  disableInput: boolean
}

export function getRuntimeMode(config: AppConfig): RuntimeMode {
  return config.runtime.mode
}

export function isLockedRuntime(mode: RuntimeMode): boolean {
  return mode === 'qa' || mode === 'production'
}

export function getRuntimeWindowPolicy(mode: RuntimeMode): RuntimeWindowPolicy {
  const locked = isLockedRuntime(mode)

  return {
    mode,
    fullscreen: locked,
    kiosk: locked,
    frame: !locked,
    movable: !locked,
    resizable: !locked,
    minimizable: !locked,
    maximizable: !locked,
    closable: !locked,
    hideCursor: locked,
    disableInput: locked,
  }
}
