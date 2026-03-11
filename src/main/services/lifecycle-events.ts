import { EventEmitter } from 'events'
import { DeviceApiError } from '../../common/types'

export interface RuntimeAuthFailureEvent {
  source: 'heartbeat' | 'command-poll' | 'command-ack' | 'proof-of-play' | 'screenshot' | 'request-queue' | 'snapshot'
  error: DeviceApiError
}

export class LifecycleEvents extends EventEmitter {
  emitRuntimeAuthFailure(event: RuntimeAuthFailureEvent): boolean {
    return this.emit('runtime-auth-failure', event)
  }

  onRuntimeAuthFailure(listener: (event: RuntimeAuthFailureEvent) => void): () => void {
    this.on('runtime-auth-failure', listener)
    return () => this.off('runtime-auth-failure', listener)
  }
}

let lifecycleEvents: LifecycleEvents | null = null

export function getLifecycleEvents(): LifecycleEvents {
  if (!lifecycleEvents) {
    lifecycleEvents = new LifecycleEvents()
  }
  return lifecycleEvents
}
