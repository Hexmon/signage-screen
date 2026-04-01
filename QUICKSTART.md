# Quick Start Guide

This guide will help you get the HexmonSignage Player up and running quickly.

For on-prem deployment, do not start with this legacy quick-start alone. Use [`../ops/onprem/QA_SETUP_GUIDE.md`](../ops/onprem/QA_SETUP_GUIDE.md) for QA or [`../ops/onprem/PRODUCTION_SETUP_GUIDE.md`](../ops/onprem/PRODUCTION_SETUP_GUIDE.md) for production. The supported on-prem profile is IP-only and points players directly at `http://<backend-ip>:3000`.

## Prerequisites

- Ubuntu 20.04 LTS or later
- Node.js 20 LTS and npm 9+
- 10GB+ free disk space

## Installation

### 1. Clone and Install Dependencies

```bash
# Clone the repository
cd signage-screen

# Install dependencies
npm install
```

### 2. Configure the Application

Copy the example configuration:

```bash
cp config.example.json config.json
```

Edit `config.json` with your settings:

```json
{
  "apiBase": "http://10.20.0.20:3000",
  "wsUrl": "ws://10.20.0.20:3000/ws",
  "deviceId": "",
  "runtime": {
    "mode": "dev"
  },
  "mtls": {
    "enabled": false
  }
}
```

For initial testing, you can disable mTLS by setting `"enabled": false`.
`runtime.mode` only supports `dev`, `qa`, and `production`.

The player switches scheduled content based on the device snapshot payload. In normal runtime, newly published schedules reach the device through backend `REFRESH` commands plus command polling, not through the raw `wsUrl` setting alone.

### 3. Build the Application

```bash
npm run build
```

### 4. Run in Development Mode

```bash
npm run start:dev
```

The application should launch in a normal window in `dev` mode. Use `qa` or `production` when you want fullscreen kiosk behavior with keyboard and mouse input disabled.

## Development Workflow

### Project Structure

```
src/
├── main/           # Main process (Node.js)
│   ├── index.ts    # Entry point ✅
│   └── services/   # Services to implement 🚧
├── renderer/       # Renderer process (Browser)
│   ├── index.html  # UI ✅
│   └── player.ts   # Player logic 🚧
├── preload/        # IPC bridge
│   └── index.ts    # Preload script ✅
└── common/         # Shared code
    ├── types.ts    # Type definitions ✅
    ├── config.ts   # Configuration ✅
    ├── logger.ts   # Logging ✅
    └── utils.ts    # Utilities ✅
```

### Next Steps for Development

#### Step 1: Implement Certificate Manager (2-3 days)

Create `src/main/services/cert-manager.ts`:

```typescript
import * as crypto from 'crypto'
import * as fs from 'fs'
import { getLogger } from '../../common/logger'

export class CertificateManager {
  private logger = getLogger('cert-manager')

  async generateCSR(deviceInfo: DeviceInfo): Promise<string> {
    // Generate ECDSA P-256 key pair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })

    // Create CSR
    // Implementation needed...
    
    return csr
  }

  async storeCertificate(cert: string, key: string, ca: string): Promise<void> {
    // Store with 0600 permissions
    // Implementation needed...
  }

  // ... more methods
}
```

#### Step 2: Implement Cache Manager (5-7 days)

Create `src/main/services/cache/cache-manager.ts`:

```typescript
import { getLogger } from '../../../common/logger'
import { CacheEntry, CacheStats } from '../../../common/types'

export class CacheManager {
  private entries = new Map<string, CacheEntry>()
  private logger = getLogger('cache-manager')

  constructor(cachePath: string, maxBytes: number) {
    // Initialize file-backed cache index
    // Implementation needed...
  }

  async get(objectKey: string): Promise<CacheEntry | null> {
    // Get cache entry
    // Implementation needed...
  }

  async put(objectKey: string, data: Buffer, sha256: string): Promise<void> {
    // Store with atomic write
    // Verify SHA-256
    // Update LRU
    // Implementation needed...
  }

  async evict(): Promise<void> {
    // LRU eviction
    // Implementation needed...
  }

  // ... more methods
}
```

#### Step 3: Implement Network Client (4-5 days)

Create `src/main/services/network/http-client.ts`:

```typescript
import axios, { AxiosInstance } from 'axios'
import * as https from 'https'
import { getLogger } from '../../../common/logger'
import { getConfigManager } from '../../../common/config'

export class HttpClient {
  private client: AxiosInstance
  private logger = getLogger('http-client')

  constructor() {
    const config = getConfigManager().getConfig()
    
    // Create axios instance with mTLS
    this.client = axios.create({
      baseURL: config.apiBase,
      timeout: 30000,
      httpsAgent: this.createHttpsAgent(),
    })

    // Add interceptors for retry logic
    // Implementation needed...
  }

  private createHttpsAgent(): https.Agent {
    const config = getConfigManager().getConfig()
    
    if (config.mtls.enabled) {
      // Load certificates
      // Implementation needed...
    }

    return new https.Agent({
      rejectUnauthorized: true,
    })
  }

  // ... more methods
}
```

### Testing

Run tests:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

### Linting and Formatting

```bash
# Lint
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check
```

## Building for Production

### Build .deb Package

```bash
npm run package:deb
```

Output: `build/hexmon-signage-player_1.0.0_amd64.deb`

### Build AppImage

```bash
npm run package:appimage
```

Output: `build/hexmon-signage-player_1.0.0_x86_64.AppImage`

### Install .deb Package

```bash
sudo dpkg -i build/hexmon-signage-player_1.0.0_amd64.deb
```

## Configuration

### Environment Variables

All configuration can be set via environment variables:

```bash
export HEXMON_API_BASE="http://10.20.0.20:3000"
export HEXMON_WS_URL="ws://10.20.0.20:3000/ws"
export HEXMON_DEVICE_ID="device-12345"
export HEXMON_MTLS_ENABLED="true"
export HEXMON_LOG_LEVEL="debug"
```

### Configuration File Locations

The application looks for configuration in this order:

1. `$HEXMON_CONFIG_PATH`
2. `$SIGNAGE_CONFIG_PATH`
3. the per-user Electron app-data config location
4. `./config.json`

## Debugging

### Enable Debug Logging

```bash
export HEXMON_LOG_LEVEL="debug"
npm run start:dev
```

### View Logs

Logs are written to:
- Development: `./cache/logs/`
- Production: the per-user runtime log directory under the player app-data root

### Diagnostics Overlay

Press `Ctrl+Shift+D` in the running application to toggle the diagnostics overlay.

### Health Check

```bash
curl http://127.0.0.1:3300/healthz
```

## Common Issues

### Issue: Application won't start

**Solution**: Check logs for errors:

```bash
tail -f cache/logs/hexmon-*.log
```

### Issue: Build fails

**Solution**: Clean and rebuild:

```bash
npm run clean
npm install
npm run build
```

### Issue: Permission denied errors

**Solution**: Ensure proper permissions:

```bash
chmod 755 ~/.config/hexmon
chmod 600 ~/.config/hexmon/config.json
```

## Next Steps

1. Review the [IMPLEMENTATION_GUIDE.md](./IMPLEMENTATION_GUIDE.md) for detailed implementation instructions
2. Check [PROJECT_STATUS.md](./PROJECT_STATUS.md) for current progress
3. Read [README.md](./README.md) for comprehensive documentation

## Getting Help

- Check the [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) guide
- Review the implementation guide
- Check the logs for error messages

## Development Tips

1. **Use TypeScript strict mode**: The project is configured with strict TypeScript. This catches many errors at compile time.

2. **Follow the logging pattern**: Use structured logging with correlation IDs:
   ```typescript
   logger.info({ scheduleId, mediaId }, 'Starting playback')
   ```

3. **Handle errors gracefully**: Always use try-catch and log errors:
   ```typescript
   try {
     await someOperation()
   } catch (error) {
     logger.error({ error }, 'Operation failed')
     // Handle gracefully
   }
   ```

4. **Test offline scenarios**: The player must work offline. Test network disconnection scenarios.

5. **Use atomic operations**: For file writes, always use the atomic write pattern (temp → rename).

6. **Verify integrity**: Always verify SHA-256 hashes for downloaded content.

7. **Implement backoff**: Use exponential backoff for retries to avoid overwhelming the server.

## Performance Monitoring

Monitor these metrics during development:

- **Cold start time**: Should be ≤5s
- **CPU usage**: Should be <40% p95
- **RAM usage**: Should be <500MB p95
- **Timeline jitter**: Should be ≤100ms p95

Use the diagnostics overlay (Ctrl+Shift+D) to monitor real-time performance.

## Security Checklist

Before deploying:

- [ ] mTLS is enabled and working
- [ ] Certificates have proper permissions (0600)
- [ ] CSP is properly configured
- [ ] Renderer is sandboxed
- [ ] Node.js integration is disabled in renderer
- [ ] Domain allowlist is configured
- [ ] PII is redacted from logs
- [ ] All inputs are sanitized

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

Apache-2.0
