# Player Runtime And Recovery Notes

## Boot policy
- If persisted `device_id`, private key, certificate, fingerprint, and CA certificate exist, the player boots into authenticated bootstrap.
- The player does not show pairing code on already-paired boot.
- Runtime is considered valid only after:
  1. authenticated snapshot succeeds
  2. authenticated heartbeat succeeds

## Recovery classification
- Transient infra failure -> `SOFT_RECOVERY`
- `403 Invalid device credentials` -> `RECOVERY_REQUIRED`
- `403 Device credentials expired` -> `RECOVERY_REQUIRED`
- `404 Device not registered` -> `HARD_RECOVERY`
- local identity corruption without a trustworthy `device_id` -> `HARD_RECOVERY`

## Cached playback policy
- If cached playable content exists, keep it visible during bootstrap and transient backend failures.
- Do not black-screen on temporary backend/network issues.
- Replace cached playback once a fresh authenticated snapshot is available.
- Resolved default media is cached locally for the paired device and is reused during `offline` and `empty` fallback modes when available.
- Default media rendering uses `contain` and reuses the same aspect-ratio-specific fallback across different resolutions of the same aspect ratio.

## Proof-of-play policy
- Proof-of-play is queued locally when offline.
- Replay queued events in order when connectivity returns.
- Screenshot upload is best-effort and must not block playback or proof-of-play replay.

## Recovery flow
- Prefer same-`device_id` recovery when backend exposes `active_pairing.mode === "RECOVERY"`.
- Use fresh pairing only when the old identity is not usable anymore.
