# Windows Runtime Validation Checklist

Use this checklist on a real Windows 10/11 x64 machine or VM. Record each step as `pass`, `degraded but acceptable`, `fail`, or `blocked`.

## Test Host Prerequisites

- Windows 10 or Windows 11 x64
- Desktop session login available
- Node.js 20 LTS
- npm
- Git
- backend reachable over LAN/IP
- sufficient local disk space for cache and logs

## Build And Package

1. Clone the player repo on the Windows machine.
2. Install dependencies.
3. Build the app.
4. Package the Windows installer.

Commands:

```powershell
cd signage-screen
npm install
npm run clean
npm run build
npm run package:win
```

Expected result:

- `build/` contains an NSIS `.exe` installer
- packaging completes without Linux-only tooling assumptions

Failure hints:

- if packaging expects Linux paths or shell tools, treat that as a Windows blocker

## Install And First Launch

1. Install the NSIS package.
2. Install to a path containing spaces if possible.
3. Launch from:
   - installer completion
   - Start Menu
   - desktop shortcut if created

Expected result:

- app launches successfully
- first launch does not crash
- if backend is not configured, the app remains usable in configuration-required/pairing state

Failure hints:

- if the app exits immediately, check packaged logs and Electron startup errors

## Runtime Paths

1. Determine the runtime root used on Windows.
2. Confirm these are created under the Electron app-data area:
   - config
   - logs
   - cache
   - certs
   - screenshots or diagnostics output if generated

Checks:

- paths are writable
- paths work with spaces
- relaunch reuses the same runtime root

Expected result:

- runtime data lives under `%APPDATA%` or the resolved per-user app-data directory

## CLI / Operator Tools

Run:

```powershell
npm run doctor
npm run clear-cache
npm run collect-logs
npm run pair:request
```

Expected result:

- commands run without Linux shell dependencies
- output paths are valid on Windows
- `doctor` is informative even when Linux-specific tools are absent

Failure hints:

- if `doctor` reports `xset`/`xrandr` absence as informational only, that is acceptable
- if the command crashes due to Linux-only assumptions, treat as failure

## Pairing And Certificates

1. Configure backend IP values.
2. Launch the player.
3. Pair with a real backend using a valid pairing code.
4. Confirm device registration appears in CMS.
5. Relaunch the app and confirm pairing persists.

Expected result:

- pairing succeeds
- certificates are written to the Windows runtime root
- subsequent API traffic uses the persisted identity

## Kiosk Behavior

Validate both `qa` and `production` runtime modes.

Checks:

- app opens fullscreen
- input-blocking policy works as intended
- cursor hiding is acceptable
- relaunch after crash preserves lock policy
- launching a second instance focuses the first instance
- multi-monitor geometry is handled safely

Expected result:

- Windows behavior matches the intended kiosk contract closely enough for deployment

## Playback

Validate all supported content types:

- image
- video
- PDF
- webpage
- default/fallback media

Checks:

- autoplay and looping work
- transitions render correctly
- webpage playback via `webview` loads and obeys lockdown/navigation restrictions
- renderer recovery works after webpage failure or unresponsive state

Expected result:

- playback is stable enough for a prolonged kiosk session

## Screenshots And Diagnostics

1. Trigger screenshot capture through the supported path.
2. Confirm the image is saved and, where applicable, uploaded.
3. Run log collection again and inspect the output bundle.

Expected result:

- screenshots are captured successfully
- diagnostics bundle includes expected logs and metadata

## Autostart

1. Enable autostart through the supported flow.
2. Sign out and sign in again.
3. Reboot the machine if practical.

Expected result:

- the app relaunches on user login
- behavior matches the user-session install model

## Upgrade

1. Install an older Windows package.
2. Pair/configure the device.
3. Install a newer NSIS package over the top.

Expected result:

- app upgrades cleanly
- config and pairing state remain intact unless intentionally migrated

## Uninstall

1. Uninstall the app.
2. Record what remains in the runtime root.

Expected result:

- only the intended runtime state remains or is removed according to product policy
- no unexpected files are left behind in program directories

## Record Sheet

Use this minimal record for each execution:

| Step | Result | Notes |
| --- | --- | --- |
| Build/package |  |  |
| Install |  |  |
| First launch |  |  |
| Runtime paths |  |  |
| CLI tools |  |  |
| Pairing |  |  |
| Kiosk `qa` |  |  |
| Kiosk `production` |  |  |
| Image playback |  |  |
| Video playback |  |  |
| PDF playback |  |  |
| Webpage playback |  |  |
| Screenshot capture |  |  |
| Log collection |  |  |
| Autostart |  |  |
| Upgrade |  |  |
| Uninstall |  |  |

## Exit Criteria

Windows is ready for broader rollout only when:

- no blocker is found in packaging, install, startup, pairing, kiosk, or playback
- Linux-only tooling is not required for the supported Windows flow
- diagnostics and autostart are acceptable for support operations
- any degraded but acceptable behavior is explicitly documented
