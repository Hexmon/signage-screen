# Ubuntu Feature Validation Matrix

## Status Key

- `Static pass` = code audit found no blocker
- `Automated coverage` = local test coverage exists for an important branch
- `Manual Ubuntu validation required` = must be executed on Ubuntu 22.04/24.04
- `legacy-only` = not part of the supported Ubuntu desktop-session workflow

## Matrix

| Feature | Primary code/files | Automated coverage | Manual Ubuntu validation | Current status |
| --- | --- | --- | --- | --- |
| Linux packaging (`package:deb`) | `package.json` | No native packaging test in this audit | Run `npm run package:deb` on Ubuntu | Manual Ubuntu validation required |
| Linux packaging (`package:appimage`) | `package.json`, `src/main/services/autostart.ts` | No native packaging test in this audit | Run `npm run package:appimage` on Ubuntu and validate `APPIMAGE`-aware exec path | Manual Ubuntu validation required |
| `.deb` install/launch | `package.json`, `UBUNTU_SETUP.md` | None | Fresh install and launch on Ubuntu desktop session | Manual Ubuntu validation required |
| `AppImage` launch | `package.json`, `UBUNTU_SETUP.md` | None | Fresh launch on Ubuntu desktop session | Manual Ubuntu validation required |
| First launch with no backend config | `src/common/config.ts`, `src/main/index.ts`, `src/renderer/pairing.ts` | `test/unit/common/config.test.ts` covers config fallback behavior | Verify packaged app stays in configuration-required/pairing state on Ubuntu | Static pass + manual Ubuntu validation required |
| Ubuntu runtime root / app-data pathing | `src/common/platform-paths.ts` | `test/unit/common/platform-paths.test.ts` | Verify config, cache, certs, logs, screenshots, and spool live under the runtime root | Static pass + automated coverage |
| Legacy Linux import | `src/common/platform-paths.ts` | `test/unit/common/platform-paths.test.ts` | Create `/etc/hexmon`, `/var/lib/hexmon`, `/var/cache/hexmon` state and validate one-time import | Static pass + automated coverage |
| CLI parsing | `src/main/cli.ts`, `src/main/cli-runner.ts` | `test/unit/main/cli.test.ts` | Run packaged or Node-driven `doctor`, `clear-cache`, `collect-logs`, `pair request`, `pair submit` on Ubuntu | Static pass + automated coverage |
| Runtime mode / kiosk policy | `src/main/runtime-mode.ts`, `src/main/index.ts` | `test/unit/main/runtime-mode.test.ts` | Verify fullscreen and locked modes in `qa` and `production` on Ubuntu | Static pass + automated coverage |
| Single instance / relaunch focus | `src/main/index.ts` | No direct automated coverage reviewed | Launch twice and confirm the existing window is focused correctly | Manual Ubuntu validation required |
| XDG autostart | `src/main/services/autostart.ts` | No Linux-branch test reviewed | Verify `~/.config/autostart/hexmon-signage-player.desktop` creation and `Exec=` correctness for installed binary and AppImage | Manual Ubuntu validation required |
| X11 power management | `src/main/services/power-manager.ts` | No Linux-branch test reviewed | Validate `xset` discovery, `preventBlanking`, and `dpmsControl` on X11 | Manual Ubuntu validation required |
| Wayland degraded path | `src/main/services/power-manager.ts`, `UBUNTU_SETUP.md` | No Linux-branch test reviewed | Validate clean startup and capability reporting with no `xset` / Wayland session | Manual Ubuntu validation required |
| Pairing request/submit flow | `src/main/services/pairing-service.ts`, `src/renderer/pairing.ts`, `src/main/services/cert-manager.ts` | `test/integration/pairing-flow.test.ts` covers logic, not packaged Ubuntu runtime | Pair against a real backend from Ubuntu and confirm cert storage | Static pass + manual Ubuntu validation required |
| Certificate storage and reuse | `src/main/services/cert-manager.ts`, `src/common/platform-paths.ts` | No Ubuntu-specific coverage reviewed | Verify certificate files are written, reused, and survive relaunch | Manual Ubuntu validation required |
| Image playback | `src/renderer/player.ts`, `src/renderer/default-media-player.ts` | Renderer/unit coverage exists, not Ubuntu-native | Validate image playback on Ubuntu | Manual Ubuntu validation required |
| Video playback | `src/renderer/player.ts`, `src/renderer/default-media-player.ts` | No Ubuntu-native codec/runtime test reviewed | Validate autoplay, looping, and codec behavior on Ubuntu | Manual Ubuntu validation required |
| PDF playback | `src/renderer/player.ts`, renderer media flow | No Ubuntu-native coverage reviewed | Validate PDF rendering and transitions on Ubuntu | Manual Ubuntu validation required |
| Webpage playback | `src/renderer/webpage-playback.ts`, `src/main/index.ts` | No Ubuntu-native coverage reviewed | Validate `webview` load, lockdown, failure recovery, and navigation restrictions | Manual Ubuntu validation required |
| Screenshot capture and upload | `src/main/services/screenshot-service.ts` | `test/unit/services/screenshot-service.test.ts` exists | Validate capture and upload from a packaged Ubuntu install | Static pass + automated coverage |
| Log collection | `src/main/services/operator-tools.ts`, `src/common/platform-paths.ts` | No Ubuntu-native coverage reviewed | Run `collect-logs` and inspect bundle contents/paths | Manual Ubuntu validation required |
| Cache clear | `src/main/services/operator-tools.ts`, cache services | `test/unit/services/cache-manager.test.ts` partially exercises cache behavior | Run `clear-cache` and verify only intended runtime data is removed | Static pass + automated coverage |
| System telemetry / health | `src/main/services/telemetry/*` | General coverage only | Verify heartbeat/system stats on Ubuntu, including missing-sensor behavior | Manual Ubuntu validation required |
| Doctor output | `src/main/services/operator-tools.ts`, `src/main/services/power-manager.ts` | CLI parsing coverage only | Confirm Ubuntu/X11/Wayland capability reporting is useful and optional tool absence is non-fatal | Manual Ubuntu validation required |
| Legacy shell scripts | `scripts/*.sh`, `scripts/hexmon-player.service` | N/A | Not applicable to supported Ubuntu path | legacy-only |

## Recommended Release Gate

Do not declare Ubuntu fully signed off until these rows are manually executed on Ubuntu and recorded:

- `.deb` packaging and install
- `AppImage` packaging and launch
- first launch / config-required state
- pairing
- XDG autostart
- kiosk behavior
- image/video/PDF/webpage playback
- screenshot capture
- log collection
- X11 `xset` path
- Wayland degraded path
- upgrade and uninstall

Use `docs/ubuntu-runtime-validation-checklist.md` as the execution record.
