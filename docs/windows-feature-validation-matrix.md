# Windows Feature Validation Matrix

## Status Key

- `Static pass` = code audit found no blocker
- `Automated coverage` = local test coverage exists for an important branch
- `Manual Windows validation required` = must be executed on Windows 10/11
- `Legacy Linux-only` = not part of supported Windows workflow

## Matrix

| Feature | Primary code/files | Automated coverage | Manual Windows validation | Current status |
| --- | --- | --- | --- | --- |
| Windows packaging (`package:win`) | `package.json` | No Windows-native packaging test in this audit | Run `npm run package:win` on Windows and inspect NSIS output | Manual Windows validation required |
| NSIS install/upgrade/uninstall | `package.json` | None | Install, relaunch, upgrade, uninstall on Windows 10/11 | Manual Windows validation required |
| First launch with no backend config | `src/common/config.ts`, `src/main/index.ts`, `src/renderer/pairing.ts` | `test/unit/common/config.test.ts` covers non-invented backend behavior | Verify packaged app stays in configuration-required/pairing state on Windows | Static pass + manual Windows validation required |
| Windows runtime root / AppData pathing | `src/common/platform-paths.ts` | `test/unit/common/platform-paths.test.ts` | Verify logs, cache, certs, config, screenshots write under AppData | Static pass + automated coverage |
| CLI parsing | `src/main/cli.ts`, `src/main/cli-runner.ts` | `test/unit/main/cli.test.ts` | Run packaged or Node-driven `doctor`, `clear-cache`, `collect-logs`, `pair request`, `pair submit` on Windows | Static pass + automated coverage |
| Runtime mode / kiosk policy | `src/main/runtime-mode.ts`, `src/main/index.ts` | `test/unit/main/runtime-mode.test.ts` | Verify fullscreen, cursor hiding, keyboard/mouse blocking in `qa` and `production` | Static pass + automated coverage |
| Single instance / relaunch focus | `src/main/index.ts` | No direct automated coverage reviewed | Launch twice and confirm existing window is focused correctly | Manual Windows validation required |
| Autostart | `src/main/services/autostart.ts` | No Windows-branch test reviewed | Verify login-item registration, sign-out/sign-in relaunch, disable path | Manual Windows validation required |
| Power-management degradation | `src/main/services/power-manager.ts` | No Windows-branch test reviewed | Confirm no `xset` failures break runtime; confirm Electron blocker behavior is acceptable | Static pass + manual Windows validation required |
| Pairing request/submit flow | `src/main/services/pairing-service.ts`, `src/renderer/pairing.ts`, `src/main/services/cert-manager.ts` | `test/integration/pairing-flow.test.ts` covers logic, not Windows packaged runtime | Pair against a real backend from Windows and confirm cert storage | Static pass + manual Windows validation required |
| mTLS certificate storage | `src/main/services/cert-manager.ts`, `src/common/platform-paths.ts` | No Windows-specific coverage reviewed | Verify cert files are written and reused across relaunch | Manual Windows validation required |
| Image playback | `src/renderer/player.ts`, `src/renderer/default-media-player.ts` | Renderer/unit coverage exists, not Windows-native | Validate slideshow/image playback on Windows | Manual Windows validation required |
| Video playback | `src/renderer/player.ts`, `src/renderer/default-media-player.ts` | No Windows codec/runtime test reviewed | Validate autoplay, looping, and codec behavior on Windows | Manual Windows validation required |
| PDF playback | `src/renderer/player.ts`, renderer media flow | No Windows-native coverage reviewed | Validate PDF display/performance on Windows | Manual Windows validation required |
| Webpage playback | `src/renderer/webpage-playback.ts`, `src/main/index.ts` | No Windows-native coverage reviewed | Validate `webview` load, lockdown, failure recovery, and navigation restrictions | Manual Windows validation required |
| Screenshot capture and upload | `src/main/services/screenshot-service.ts` | `test/unit/services/screenshot-service.test.ts` exists, not Windows-native | Validate capturePage path, saved files, upload flow | Static pass + manual Windows validation required |
| Log collection | `src/main/services/operator-tools.ts`, `src/common/platform-paths.ts` | No Windows-native coverage reviewed | Run `collect-logs` and inspect archive contents/paths | Manual Windows validation required |
| Cache clear | `src/main/services/operator-tools.ts`, cache services | No Windows-native coverage reviewed | Run `clear-cache` and confirm only intended runtime data is removed | Manual Windows validation required |
| System telemetry / health | `src/main/services/telemetry/*` | General coverage only | Verify heartbeat/system stats on Windows; temperature may be absent and acceptable | Static pass + manual Windows validation required |
| POP spool / offline buffering | `src/main/services/pop-service.ts`, `src/main/services/log-shipper.ts` | Unit coverage exists, not Windows-native | Validate spool file creation/flush under AppData paths | Manual Windows validation required |
| Operator doctor output | `src/main/services/operator-tools.ts` | CLI parsing coverage only | Confirm Windows output is useful and does not treat absent Linux tools as fatal | Manual Windows validation required |
| Linux shell scripts | `scripts/*.sh`, `scripts/hexmon-player.service` | N/A | Not applicable to Windows | Legacy Linux-only |
| Linux legacy import | `src/common/platform-paths.ts` | `test/unit/common/platform-paths.test.ts` | Confirm it does not run on Windows | Static pass + automated coverage |

## Recommended Release Gate

Do not declare Windows fully signed off until these rows are manually executed on a Windows machine and recorded:

- Windows packaging
- NSIS install/upgrade/uninstall
- first launch / config-required state
- pairing
- kiosk behavior
- image/video/PDF/webpage playback
- screenshot capture
- log collection
- autostart

Use `docs/windows-runtime-validation-checklist.md` as the execution record.
