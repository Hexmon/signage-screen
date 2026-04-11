export const REQUEST_QUEUE_TOTAL_MAX_ITEMS = 256
export const REQUEST_QUEUE_TOTAL_BYTES_FRACTION = 0.01
export const REQUEST_QUEUE_TOTAL_BYTES_MIN = 512 * 1024
export const REQUEST_QUEUE_TOTAL_BYTES_MAX = 8 * 1024 * 1024

export const POP_REPLAY_BUFFER_MAX_EVENTS = 100
export const POP_REPLAY_BUFFER_MAX_BYTES = 512 * 1024
export const POP_REPLAY_SPOOL_MAX_FILES = 32
export const POP_REPLAY_SPOOL_BYTES_FRACTION = 0.02
export const POP_REPLAY_SPOOL_BYTES_MIN = 1024 * 1024
export const POP_REPLAY_SPOOL_BYTES_MAX = 16 * 1024 * 1024
export const POP_REPLAY_MAX_EVENTS_PER_FILE = 50
export const POP_REPLAY_MAX_BATCH_SIZE = 25

export function clampBudget(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function deriveRequestQueueMaxBytes(cacheMaxBytes: number): number {
  return clampBudget(
    Math.round(cacheMaxBytes * REQUEST_QUEUE_TOTAL_BYTES_FRACTION),
    REQUEST_QUEUE_TOTAL_BYTES_MIN,
    REQUEST_QUEUE_TOTAL_BYTES_MAX
  )
}

export function deriveProofOfPlaySpoolMaxBytes(cacheMaxBytes: number): number {
  return clampBudget(
    Math.round(cacheMaxBytes * POP_REPLAY_SPOOL_BYTES_FRACTION),
    POP_REPLAY_SPOOL_BYTES_MIN,
    POP_REPLAY_SPOOL_BYTES_MAX
  )
}
