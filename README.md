# HexmonSignage Player

Production-grade Windows and Ubuntu Electron digital signage player with offline-first architecture, mTLS authentication, and comprehensive telemetry.

See [PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md) for the current production and development support matrix.

## Features

### Core Capabilities
- **Offline-First Architecture**: Continues operation without constant connectivity
- **mTLS Authentication**: Secure device authentication with certificate pinning
- **Content Cache**: LRU cache with SHA-256 integrity verification and resume support
- **Multi-Format Support**: Images (jpg, png, avif, webp), Video (mp4, mov), PDF, URLs
- **Scheduling Engine**: Immutable schedule snapshots with prefetching
- **Emergency Override**: High-priority interrupt system
- **Proof-of-Play**: Comprehensive playback tracking with offline spooling
- **Telemetry & Health**: System metrics, heartbeats, and health endpoints
- **Device Commands**: Remote control via device-command polling; publish refresh is command-driven
- **Power Management**: DPMS control and scheduled on/off times

### Security
- Strict Content Security Policy (CSP)
- Renderer process sandboxing with Node.js disabled
- Context isolation enabled
- Domain allowlist for remote content
- PII redaction in logs
- Secure file permissions (0600 for secrets)
- mTLS with pinned CA

### Reliability
- Single-instance enforcement
- Crash auto-restart with bounded exponential backoff
- Atomic file writes
- Journal-safe operations
- Graceful degradation on network loss
- WebSocket → HTTP polling fallback

## Architecture

```
src/
├── main/           # Main process (orchestration)
│   ├── index.ts
│   ├── services/   # Core services
│   │   ├── cache/
│   │   ├── network/
│   │   ├── telemetry/
│   │   ├── playback/
│   │   ├── commands/
│   │   └── power/
│   └── managers/   # High-level managers
├── renderer/       # Renderer process (UI)
│   ├── index.html
│   ├── player.ts
│   └── pairing.ts
├── preload/        # Preload scripts (IPC bridge)
│   └── index.ts
└── common/         # Shared code
    ├── types.ts
    ├── config.ts
    ├── logger.ts
    └── utils.ts
```

## Installation

### Prerequisites
- Windows 10/11 desktop session or Ubuntu 22.04+ desktop session
- Node.js 20 LTS and npm 9+ for source builds
- 10GB+ free disk space for cache

### From Package
Windows:
```powershell
HexmonSignage-Player-Setup.exe
```

Ubuntu:
```bash
sudo dpkg -i hexmon-signage-player_1.0.0_amd64.deb
# or run the AppImage directly
./HexmonSignage-Player-1.0.0.AppImage
```

### From Source
```bash
git clone https://github.com/hexmon/signage-player.git
cd signage-player
npm install
npm run build
npm run package:linux
# or
npm run package:win
```

## Configuration

Configuration is loaded from (in order of precedence):
1. Environment variables (`HEXMON_*`)
2. The configured `HEXMON_CONFIG_PATH` / `SIGNAGE_CONFIG_PATH`
3. The per-user Electron app-data directory
4. Built-in defaults

On Linux, legacy `/etc/hexmon`, `/var/lib/hexmon`, and `/var/cache/hexmon` state is imported once into the app-data runtime root when no explicit override paths are set.

### Example Configuration

```json
{
  "apiBase": "https://api.hexmon.local",
  "wsUrl": "wss://api.hexmon.local/ws",
  "deviceId": "",
  "runtime": {
    "mode": "production"
  },
  "mtls": {
    "enabled": true,
    "autoRenew": true,
    "renewBeforeDays": 30
  },
  "cache": {
    "maxBytes": 10737418240,
    "prefetchConcurrency": 3,
    "bandwidthBudgetMbps": 50
  },
  "intervals": {
    "heartbeatMs": 60000,
    "commandPollMs": 5000,
    "schedulePollMs": 300000,
    "healthCheckMs": 60000
  },
  "log": {
    "level": "info",
    "shipPolicy": "batch",
    "rotationSizeMb": 100,
    "rotationIntervalHours": 24,
    "compressionEnabled": true
  },
  "power": {
    "dpmsEnabled": true,
    "preventBlanking": true,
    "scheduleEnabled": false,
    "onTime": "08:00",
    "offTime": "18:00"
  },
  "security": {
    "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    "allowedDomains": ["hexmon.local", "*.hexmon.com"],
    "disableEval": true,
    "contextIsolation": true,
    "nodeIntegration": false,
    "sandbox": true
  }
}
```

`runtime.mode` only supports `dev`, `qa`, and `production`.

- `dev`: windowed app, no kiosk lock, keyboard and mouse remain available
- `qa`: fullscreen kiosk with mouse and keyboard input blocked
- `production`: fullscreen kiosk with mouse and keyboard input blocked

### Environment Variables

All configuration options can be set via environment variables with the `HEXMON_` prefix:

```bash
export HEXMON_API_BASE="https://api.hexmon.local"
export HEXMON_WS_URL="wss://api.hexmon.local/ws"
export HEXMON_DEVICE_ID="device-12345"
export HEXMON_RUNTIME_MODE="qa"
export HEXMON_MTLS_ENABLED="true"
export HEXMON_CACHE_MAX_BYTES="10737418240"
export HEXMON_LOG_LEVEL="debug"
```

## Schedule refresh model

- The player learns schedule timing from `GET /api/v1/device/:deviceId/snapshot`.
- After a schedule is published, the backend queues a `REFRESH` device command for affected screens.
- The player polls device commands, fetches a fresh snapshot immediately, and then uses its local schedule boundary timer to switch at the exact `start_at`.
- The checked-in raw `wsUrl` setting is not the authoritative publish-to-screen path for playback updates in the current runtime.

## Device Pairing

On first run, the player displays a pairing screen:

1. Enter the 6-character pairing code from the admin dashboard
2. Player generates ECDSA (P-256) CSR locally
3. Sends pairing request to backend: `POST /v1/device-pairing/complete`
4. Receives device certificate and configuration
5. Stores certificate with 0600 permissions
6. Switches to mTLS for all subsequent requests

### Manual Pairing

```bash
# Choose a writable cert directory. The packaged player defaults to the
# per-user runtime root, or you can set HEXMON_MTLS_CERT_DIR explicitly.
export HEXMON_MTLS_CERT_DIR="${HOME}/.config/HexmonSignage Player/certs"
mkdir -p "${HEXMON_MTLS_CERT_DIR}"

# Generate CSR
openssl ecparam -name prime256v1 -genkey -noout -out "${HEXMON_MTLS_CERT_DIR}/client.key"
openssl req -new -key "${HEXMON_MTLS_CERT_DIR}/client.key" -out /tmp/client.csr

# Submit pairing request
curl -X POST https://api.hexmon.local/v1/device-pairing/complete \
  -H "Content-Type: application/json" \
  -d '{"pairing_code":"ABC123","csr":"<CSR_CONTENT>"}'

# Save certificate
echo "<CERT_CONTENT>" > "${HEXMON_MTLS_CERT_DIR}/client.crt"
echo "<CA_CONTENT>" > "${HEXMON_MTLS_CERT_DIR}/ca.crt"
chmod 600 "${HEXMON_MTLS_CERT_DIR}"/*
```

## Usage

### Starting the Player

```bash
# Packaged install
hexmon-signage-player

# Operator commands
hexmon-signage-player doctor
hexmon-signage-player pair request
hexmon-signage-player pair submit ABC123
hexmon-signage-player clear-cache
hexmon-signage-player collect-logs

# Development mode
npm run start:dev
```

`npm run start:dev` defaults the player to `runtime.mode=dev` unless a config file explicitly overrides it.

Autostart is managed at the user-session level:

- Windows: login item registration
- Ubuntu: XDG autostart desktop entry

### Health Check

```bash
curl http://127.0.0.1:3300/healthz
```

Response:
```json
{
  "status": "healthy",
  "appVersion": "1.0.0",
  "uptime": 3600,
  "lastScheduleSync": "2025-01-01T12:00:00Z",
  "cacheUsage": {
    "totalBytes": 10737418240,
    "usedBytes": 5368709120,
    "freeBytes": 5368709120,
    "entryCount": 42,
    "quarantinedCount": 0
  },
  "lastErrors": [],
  "systemStats": {
    "cpuUsage": 25.5,
    "memoryUsage": 450000000,
    "memoryTotal": 8000000000,
    "diskUsage": 50000000000,
    "diskTotal": 100000000000,
    "uptime": 3600
  },
  "timestamp": "2025-01-01T12:00:00Z"
}
```

### Diagnostics Overlay

Press `Ctrl+Shift+D` to toggle the diagnostics overlay showing:
- Device ID and IP address
- WebSocket connection state
- Last schedule sync time
- Cache usage percentage
- Command queue status
- Current screen mode

## API Contracts

### Backend Endpoints

- `POST /v1/device-pairing/complete` - Device pairing
- `POST /v1/device/heartbeat` - Telemetry heartbeat
- `POST /v1/device/proof-of-play` - Proof-of-play events
- `POST /v1/device/screenshot` - Screenshot upload
- `GET /v1/device/:deviceId/commands` - Poll for commands
- `POST /v1/device/:deviceId/commands/:cmdId/ack` - Command acknowledgment
- `GET /v1/device/:deviceId/schedule` - Fetch schedule snapshot
- `GET /v1/device/:deviceId/emergency` - Check emergency override
- `POST /v1/device/logs` - Upload log bundles

### WebSocket Messages

```typescript
// Emergency override
{
  "type": "emergency",
  "payload": {
    "id": "emergency-123",
    "active": true,
    "content": { /* TimelineItem */ }
  }
}

// Device command
{
  "type": "command",
  "payload": {
    "id": "cmd-456",
    "type": "SCREENSHOT",
    "payload": {}
  }
}

// Schedule update notification
{
  "type": "schedule_update",
  "payload": {
    "scheduleId": "schedule-789",
    "version": 2
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Lint
npm run lint
npm run lint:fix

# Format
npm run format
npm run format:check

# Test
npm run test
npm run test:watch

# Package
npm run package          # All formats
npm run package:deb      # .deb only
npm run package:appimage # AppImage only
```

## Performance Targets

- Cold start → first frame: ≤5s (warm cache)
- CPU usage: <40% p95 during image playback
- RAM usage: <500MB p95
- Timeline jitter: ≤100ms p95
- Cache integrity errors: 0
- Download success rate: ≥99.9%

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues and solutions.

## Security

See [SECURITY.md](./SECURITY.md) for security considerations and reporting vulnerabilities.

## License

Apache-2.0

## Support

For support, please contact support@hexmon.com or visit https://docs.hexmon.com
