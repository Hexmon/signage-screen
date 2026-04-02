# Setup Guide

Complete setup instructions for the HexmonSignage Player in both development and production environments.

## Table of Contents

- [Development Setup](#development-setup)
- [Production Setup](#production-setup)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

---

## Development Setup

### Prerequisites

#### Required Software

- **Node.js**: Version 18.x or later (LTS recommended)
- **npm**: Version 9.x or later (comes with Node.js)
- **Git**: Latest version
- **Operating System**: 
  - Windows 10/11 (for development)
  - Ubuntu 20.04 LTS or later (for testing)
  - macOS 12+ (optional)

#### Recommended Tools

- **Visual Studio Code**: With TypeScript and ESLint extensions
- **Postman**: For API testing
- **Docker**: For running test services (optional)

#### Check Prerequisites

```bash
# Check Node.js version
node --version
# Should output: v18.x.x or later

# Check npm version
npm --version
# Should output: 9.x.x or later

# Check Git version
git --version
# Should output: git version 2.x.x or later
```

### Installation Steps

#### 1. Clone Repository

```bash
# Clone the repository
git clone https://github.com/hexmon/signage-player.git
cd signage-player
```

#### 2. Install Dependencies

```bash
# Install all dependencies
npm install

# This will install:
# - Production dependencies (Electron, Axios, etc.)
# - Development dependencies (TypeScript, ESLint, Mocha, etc.)
```

**Expected output:**
```
added 500+ packages in 30s
```

#### 3. Configure Development Environment

Create a development configuration file:

```bash
# Copy example configuration
cp config.example.json config.dev.json
```

Edit `config.dev.json`:

```json
{
  "apiBase": "http://localhost:3000",
  "wsUrl": "ws://localhost:3000/ws",
  "deviceId": "dev-device-001",
  "logLevel": "debug",
  "mTLS": {
    "enabled": false,
    "certPath": "./dev-certs"
  },
  "cache": {
    "path": "./dev-cache",
    "maxBytes": 1073741824
  },
  "intervals": {
    "heartbeatMs": 60000,
    "schedulePollMs": 30000,
    "commandPollMs": 10000
  }
}
```

Set environment variable:

```bash
# Windows (PowerShell)
$env:HEXMON_CONFIG_PATH = "config.dev.json"

# Linux/macOS
export HEXMON_CONFIG_PATH=config.dev.json
```

#### 4. Build the Project

```bash
# Build TypeScript to JavaScript
npm run build
```

**Expected output:**
```
> hexmon-signage-player@1.0.0 build
> tsc

Compiled successfully.
```

#### 5. Run in Development Mode

```bash
# Start the application in development mode
npm run start:dev
```

**Expected output:**
```
[INFO] Application starting
[INFO] Services initialized
[INFO] Window created
```

The application window should open displaying the player interface.

### Development Workflow

#### Running Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit           # Unit tests only
npm run test:integration    # Integration tests only
npm run test:performance    # Performance tests only
npm run test:all            # All tests including performance

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

#### Code Quality

```bash
# Lint code
npm run lint

# Fix linting issues automatically
npm run lint -- --fix

# Format code
npm run format

# Type check
npm run type-check
```

#### Building Packages

```bash
# Build .deb package (requires Linux or WSL)
npm run package:deb

# Build AppImage (requires Linux or WSL)
npm run package:appimage

# Build for current platform
npm run package
```

#### Development Scripts

```bash
# Clean build artifacts
npm run clean

# Rebuild from scratch
npm run clean && npm run build

# Watch mode (auto-rebuild on changes)
npm run dev
```

### Development Environment Setup

#### Visual Studio Code

Recommended extensions:

```json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "ms-vscode.vscode-typescript-next",
    "orta.vscode-jest"
  ]
}
```

Workspace settings (`.vscode/settings.json`):

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "typescript.tsdk": "node_modules/typescript/lib",
  "eslint.validate": ["typescript"],
  "files.exclude": {
    "dist": true,
    "build": true,
    "node_modules": true
  }
}
```

#### Debugging

Launch configuration (`.vscode/launch.json`):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Main Process",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
      "windows": {
        "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron.cmd"
      },
      "args": [".", "--remote-debugging-port=9223"],
      "outputCapture": "std",
      "sourceMaps": true,
      "resolveSourceMapLocations": [
        "${workspaceFolder}/**",
        "!**/node_modules/**"
      ]
    },
    {
      "name": "Debug Renderer Process",
      "type": "chrome",
      "request": "attach",
      "port": 9223,
      "webRoot": "${workspaceFolder}",
      "timeout": 30000
    }
  ]
}
```

### Common Development Tasks

#### Adding a New Service

1. Create service file in `src/main/services/`
2. Implement service class with singleton pattern
3. Add service initialization in `src/main/index.ts`
4. Create unit tests in `test/unit/services/`
5. Update documentation

#### Adding a New API Endpoint

1. Update HTTP client in `src/main/services/network/http-client.ts`
2. Add type definitions in `src/common/types.ts`
3. Create integration test
4. Update API.md documentation

#### Modifying Configuration

1. Update `src/common/config.ts`
2. Update `config.example.json`
3. Update validation logic
4. Update documentation

### Troubleshooting Development Issues

#### Issue: `npm install` fails

**Solution:**
```bash
# Clear npm cache
npm cache clean --force

# Delete node_modules and package-lock.json
rm -rf node_modules package-lock.json

# Reinstall
npm install
```

#### Issue: TypeScript compilation errors

**Solution:**
```bash
# Check TypeScript version
npx tsc --version

# Clean and rebuild
npm run clean
npm run build
```

#### Issue: Electron window doesn't open

**Solution:**
```bash
# Check if another instance is running
# Kill any running instances

# Check logs
cat dev-cache/logs/hexmon-*.log

# Run with debug output
DEBUG=* npm run start:dev
```

#### Issue: Tests fail

**Solution:**
```bash
# Run tests with verbose output
npm test -- --reporter spec

# Run single test file
npx mocha --require ts-node/register test/unit/common/utils.test.ts

# Clear test cache
rm -rf test/fixtures/temp
```

#### Issue: Module not found errors

**Solution:**
```bash
# Ensure all dependencies are installed
npm install

# Check for missing peer dependencies
npm ls

# Rebuild native modules
npm rebuild
```

---

## Production Setup

### System Requirements

#### Minimum Requirements

- **OS**: Ubuntu 20.04 LTS or later (64-bit)
- **CPU**: 2 cores (x86_64 or ARM64)
- **RAM**: 2GB
- **Disk**: 20GB free space
- **Network**: Stable internet connection (10 Mbps+)
- **Display**: HDMI output, 1920x1080 or higher

#### Recommended Requirements

- **OS**: Ubuntu 22.04 LTS (64-bit)
- **CPU**: 4 cores (x86_64), 2.0 GHz+
- **RAM**: 4GB
- **Disk**: 50GB SSD
- **Network**: 50 Mbps+ with low latency (<50ms)
- **Display**: 1920x1080 or 4K, HDMI 2.0+

#### Software Dependencies

These are automatically installed with the package:

- Node.js 18+ (bundled)
- X11 display server
- OpenSSL 1.1.1+
- systemd

### Pre-Installation Checklist

- [ ] Ubuntu system installed and updated
- [ ] Network connectivity verified
- [ ] Display connected and working
- [ ] Backend API accessible
- [ ] Pairing code obtained from admin dashboard
- [ ] Firewall rules configured (allow HTTPS/WSS)
- [ ] System time synchronized (NTP)
- [ ] Sufficient disk space available

### Installation Methods

#### Method 1: .deb Package (Recommended)

##### 1. Download Package

```bash
# Download latest release
wget https://releases.hexmon.com/hexmon-signage-player_1.0.0_amd64.deb

# Or use curl
curl -O https://releases.hexmon.com/hexmon-signage-player_1.0.0_amd64.deb
```

##### 2. Install Package

```bash
# Install the package
sudo dpkg -i hexmon-signage-player_1.0.0_amd64.deb

# Fix any dependency issues
sudo apt-get install -f
```

##### 3. Verify Installation

```bash
# Check if installed
which hexmon-signage-player

# Check version
hexmon-signage-player --version

# Check service status
sudo systemctl status hexmon-player
```

**Expected output:**
```
hexmon-signage-player version 1.0.0
```

#### Method 2: AppImage

##### 1. Download AppImage

```bash
wget https://releases.hexmon.com/HexmonSignage-Player-1.0.0.AppImage
chmod +x HexmonSignage-Player-1.0.0.AppImage
```

##### 2. Run AppImage

```bash
./HexmonSignage-Player-1.0.0.AppImage
```

**Note**: AppImage doesn't include systemd service. Use .deb package for production.

#### Method 3: Build from Source

##### 1. Install Build Dependencies

```bash
sudo apt-get update
sudo apt-get install -y \
  nodejs \
  npm \
  git \
  build-essential \
  libx11-dev \
  libxext-dev
```

##### 2. Clone and Build

```bash
git clone https://github.com/hexmon/signage-player.git
cd signage-player
npm install
npm run build
npm run package:deb
```

##### 3. Install Built Package

```bash
sudo dpkg -i build/hexmon-signage-player_1.0.0_amd64.deb
```

### Configuration

#### 1. Edit Configuration File

```bash
sudo nano /etc/hexmon/config.json
```

#### 2. Required Configuration

```json
{
  "apiBase": "https://api.hexmon.com",
  "wsUrl": "wss://api.hexmon.com/ws",
  "deviceId": "",
  "logLevel": "info",
  "mTLS": {
    "enabled": true,
    "certPath": "/var/lib/hexmon/certs"
  },
  "cache": {
    "path": "/var/cache/hexmon",
    "maxBytes": 10737418240
  },
  "intervals": {
    "heartbeatMs": 300000,
    "schedulePollMs": 300000,
    "commandPollMs": 30000,
    "popFlushMs": 60000
  },
  "display": {
    "width": 1920,
    "height": 1080,
    "fullscreen": true
  }
}
```

#### 3. Set Permissions

```bash
sudo chown root:hexmon /etc/hexmon/config.json
sudo chmod 640 /etc/hexmon/config.json
```

### Device Pairing

#### Interactive Pairing (Recommended)

```bash
sudo hexmon-pair-device
```

Follow the prompts:
1. Enter 6-character pairing code from admin dashboard
2. Wait for certificate generation
3. Verify pairing success

**Expected output:**
```
HexmonSignage Player - Device Pairing
======================================

Enter 6-character pairing code: ABC123

Pairing device...
✓ Key pair generated
✓ CSR generated
✓ Pairing successful!

Device ID: dev_abc123xyz
✓ Certificates saved
✓ Configuration updated

Pairing complete! You can now start the service:
  sudo systemctl start hexmon-player
```

#### Manual Pairing

If interactive pairing fails, use manual pairing:

```bash
# 1. Generate key pair
sudo openssl ecparam -name prime256v1 -genkey -noout \
  -out /var/lib/hexmon/certs/client.key
sudo chmod 600 /var/lib/hexmon/certs/client.key

# 2. Generate CSR
sudo openssl req -new \
  -key /var/lib/hexmon/certs/client.key \
  -out /var/lib/hexmon/certs/client.csr \
  -subj "/CN=$(hostname)/O=HexmonSignage/C=US"

# 3. Submit CSR to admin dashboard and download certificates

# 4. Save certificates
sudo nano /var/lib/hexmon/certs/client.crt  # Paste client certificate
sudo nano /var/lib/hexmon/certs/ca.crt      # Paste CA certificate

# 5. Set permissions
sudo chmod 600 /var/lib/hexmon/certs/*.crt

# 6. Update config with device ID
sudo nano /etc/hexmon/config.json
```

### Service Management

#### Enable Service

```bash
sudo systemctl enable hexmon-player
```

#### Start Service

```bash
sudo systemctl start hexmon-player
```

#### Check Status

```bash
sudo systemctl status hexmon-player
```

**Expected output:**
```
● hexmon-player.service - HexmonSignage Player
     Loaded: loaded (/etc/systemd/system/hexmon-player.service; enabled)
     Active: active (running) since Mon 2025-01-05 10:00:00 UTC
   Main PID: 1234 (hexmon-signage-)
      Tasks: 15
     Memory: 250.0M
     CGroup: /system.slice/hexmon-player.service
             └─1234 /usr/bin/hexmon-signage-player
```

#### View Logs

```bash
# Real-time logs
sudo journalctl -u hexmon-player -f

# Last 100 lines
sudo journalctl -u hexmon-player -n 100

# Logs since boot
sudo journalctl -u hexmon-player -b

# Application logs
sudo tail -f /var/cache/hexmon/logs/hexmon-*.log
```

#### Restart Service

```bash
sudo systemctl restart hexmon-player
```

#### Stop Service

```bash
sudo systemctl stop hexmon-player
```

### Monitoring and Health Checks

#### Health Endpoint

```bash
# Check health
curl http://127.0.0.1:3300/healthz

# Pretty print with jq
curl -s http://127.0.0.1:3300/healthz | jq .
```

**Expected output:**
```json
{
  "status": "healthy",
  "uptime": 86400,
  "version": "1.0.0",
  "device_id": "dev_abc123xyz",
  "paired": true,
  "schedule": {
    "id": "sched_abc123",
    "version": 42,
    "last_sync": "2025-01-05T12:00:00Z"
  },
  "playback": {
    "state": "playing",
    "current_media": "item_001"
  },
  "cache": {
    "used_bytes": 10737418240,
    "total_bytes": 53687091200,
    "items": 42
  }
}
```

#### Metrics Endpoint

```bash
# Get Prometheus metrics
curl http://127.0.0.1:3300/metrics
```

#### Diagnostics Overlay

Press `Ctrl+Shift+D` on the display to toggle diagnostics overlay showing:
- Device ID
- IP address
- WebSocket status
- Last sync time
- Cache usage
- Command queue size
- Uptime
- Version

### Security Hardening

#### 1. File Permissions

```bash
# Certificate directory
sudo chmod 700 /var/lib/hexmon/certs
sudo chmod 600 /var/lib/hexmon/certs/*

# Configuration
sudo chmod 640 /etc/hexmon/config.json
sudo chown root:hexmon /etc/hexmon/config.json

# Cache directory
sudo chmod 755 /var/cache/hexmon
sudo chown -R hexmon:hexmon /var/cache/hexmon
```

#### 2. Firewall Configuration

```bash
# Allow HTTPS
sudo ufw allow 443/tcp

# Allow health endpoint (localhost only)
sudo ufw allow from 127.0.0.1 to any port 3300

# Enable firewall
sudo ufw enable
```

#### 3. Automatic Updates

```bash
# Enable unattended upgrades
sudo apt-get install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

#### 4. Disable Unnecessary Services

```bash
# Disable SSH if not needed
sudo systemctl disable ssh

# Disable Bluetooth
sudo systemctl disable bluetooth
```

### Backup and Recovery

#### Backup Configuration

```bash
# Create backup
sudo tar -czf hexmon-backup-$(date +%Y%m%d).tar.gz \
  /etc/hexmon/ \
  /var/lib/hexmon/certs/

# Store backup securely
sudo mv hexmon-backup-*.tar.gz /backup/location/
```

#### Restore Configuration

```bash
# Extract backup
sudo tar -xzf hexmon-backup-20250105.tar.gz -C /

# Restart service
sudo systemctl restart hexmon-player
```

#### Disaster Recovery

If device fails completely:

1. Install fresh Ubuntu
2. Install HexmonSignage Player package
3. Restore configuration from backup
4. If certificates lost, re-pair device
5. Start service

### Update Procedures

#### Update Application

```bash
# 1. Backup current installation
sudo hexmon-collect-logs
sudo tar -czf backup.tar.gz /etc/hexmon /var/lib/hexmon/certs

# 2. Download new version
wget https://releases.hexmon.com/hexmon-signage-player_1.1.0_amd64.deb

# 3. Stop service
sudo systemctl stop hexmon-player

# 4. Install update
sudo dpkg -i hexmon-signage-player_1.1.0_amd64.deb

# 5. Start service
sudo systemctl start hexmon-player

# 6. Verify
curl http://127.0.0.1:3300/healthz
```

#### Update System

```bash
# Update system packages
sudo apt-get update
sudo apt-get upgrade

# Reboot if kernel updated
sudo reboot
```

### Troubleshooting Production Issues

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for comprehensive troubleshooting guide.

#### Quick Diagnostics

```bash
# Collect diagnostic information
sudo hexmon-collect-logs

# Check service status
sudo systemctl status hexmon-player

# Check health
curl http://127.0.0.1:3300/healthz

# View recent logs
sudo journalctl -u hexmon-player -n 50
```

#### Common Issues

**Service won't start:**
```bash
# Check configuration
sudo cat /etc/hexmon/config.json | jq .

# Check permissions
ls -la /var/lib/hexmon/certs/

# Check logs
sudo journalctl -u hexmon-player -n 100
```

**No display output:**
```bash
# Check DISPLAY variable
echo $DISPLAY

# Check X11 access
xhost +SI:localuser:hexmon

# Test display
DISPLAY=:0 xeyes
```

**Network issues:**
```bash
# Test API connectivity
curl -I https://api.hexmon.com

# Test DNS
nslookup api.hexmon.com

# Check firewall
sudo ufw status
```

---

## Additional Resources

- [Installation Guide](./INSTALL.md)
- Deployment guide: `signhex-platform/docs/runbooks/player-deployment.md`
- [Troubleshooting Guide](./TROUBLESHOOTING.md)
- [Security Guide](./SECURITY.md)
- [API Documentation](./API.md)
- [Testing Guide](./TEST.md)

---

**Last Updated**: 2025-01-05
**Version**: 1.0.0
