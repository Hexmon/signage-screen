# HexmonSignage Player Platform Support

## Support Matrix

| Platform | Status | Notes |
| --- | --- | --- |
| Windows desktop | Production | Supported as a user-session kiosk/player install with NSIS packaging and login-item autostart. |
| Ubuntu desktop | Production | Supported as a user-session kiosk/player install with deb/AppImage packaging and XDG autostart. |
| macOS | Development only | Supported for local development and validation. Not an official production target. |

## Runtime Model

- The supported production model is a logged-in desktop session on Windows and Ubuntu.
- Autostart is managed at the user-session level:
  - Windows: login item registration
  - Ubuntu: XDG autostart desktop entry
- The player no longer depends on Linux-only postinstall scripts for the primary supported install path.

## Operator Commands

Run the packaged executable or `electron .` with:

- `doctor`
- `pair request`
- `pair submit <PAIRING_CODE>`
- `clear-cache`
- `collect-logs`

Equivalent npm helpers are available for development:

- `npm run doctor`
- `npm run clear-cache`
- `npm run collect-logs`

## Linux Legacy Paths

When the player starts on Linux with no explicit runtime-path overrides, it will perform a one-time import from these legacy locations if they exist:

- `/etc/hexmon/config.json`
- `/var/lib/hexmon/certs`
- `/var/cache/hexmon`

The new primary runtime root is the Electron app-data directory.

## Feature Notes

- Display power control remains Linux/X11-specific and degrades cleanly on Windows and Wayland.
- Display enumeration now uses Electron APIs on all supported platforms.
- Cache clearing and log collection are implemented in Node/Electron code and no longer depend on Linux shell tooling.
- For the Ubuntu step-by-step install and verification flow, use [UBUNTU_SETUP.md](./UBUNTU_SETUP.md).
