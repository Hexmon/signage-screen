# Windows Compatibility Audit

## Summary

This audit answers the question: can `signage-screen` be packaged, installed, launched, paired, run in kiosk mode, autostart, play content, collect diagnostics, and degrade safely on Windows without Linux assumptions leaking into runtime behavior?

Static audit result: **largely yes in code structure**, with **no confirmed Windows blocker found in the audited runtime paths**, but **native Windows packaging and runtime validation is still required before calling the Windows path release-ready**.

Evidence gathered in this audit:

- Local TypeScript/Electron build passed: `npm run build`
- Focused Windows-adjacent automated tests passed:
  - `test/unit/common/config.test.ts`
  - `test/unit/common/platform-paths.test.ts`
  - `test/unit/main/cli.test.ts`
  - `test/unit/main/runtime-mode.test.ts`
- Packaging, install, autostart, kiosk behavior, media playback, screenshot capture, and updater behavior were **not** executed on a native Windows 10/11 machine in this audit session

This report is therefore a **static readiness audit plus validation plan**, not a final native Windows sign-off.

## Scope

Audited buckets:

- `src/common/`
- `src/main/`
- `src/renderer/`
- `src/preload/`
- `scripts/`
- packaging config in `package.json`
- tests under `test/`
- operator-facing docs that still influence packaging/install/support behavior

## Findings

### High

1. Native Windows packaging and runtime validation is still missing.
   Files/areas:
   - `package.json`
   - `src/main/index.ts`
   - `src/main/services/autostart.ts`
   - `src/renderer/webpage-playback.ts`
   - `src/main/services/screenshot-service.ts`
   Why it matters:
   - the code is structured for Windows support, but there is no audit evidence here for NSIS install, packaged-mode startup, login-item autostart, kiosk enforcement, webview stability, or screenshot capture on a real Windows machine
   Required before Windows release:
   - run the checklist in `docs/windows-runtime-validation-checklist.md` on Windows 10/11 x64

### Medium

2. Legacy Linux docs and shell scripts are still prominent enough to mislead operators.
   Files:
   - `INSTALL.md`
   - `SETUP.md`
   - `TROUBLESHOOTING.md`
   - `SECURITY.md`
   - `scripts/postinstall.sh`
   - `scripts/postremove.sh`
   - `scripts/pair-device.sh`
   - `scripts/collect-logs.sh`
   - `scripts/clear-cache.sh`
   - `scripts/hexmon-player.service`
   Why it matters:
   - these paths still reference `systemd`, `/etc/hexmon`, `/var/lib/hexmon`, `/var/cache/hexmon`, `.deb`, `AppImage`, `xrandr`, and `xset` as if they were primary operator workflows
   Current status:
   - runtime code has moved toward per-user Electron app-data roots and user-session autostart, but the legacy docs and scripts still exist in-tree

3. Windows-specific runtime paths are implemented, but several important branches remain only partially test-backed.
   Files:
   - `src/common/platform-paths.ts`
   - `src/common/config.ts`
   - `src/main/services/autostart.ts`
   - `src/main/services/power-manager.ts`
   - `src/main/services/operator-tools.ts`
   - `src/main/services/cert-manager.ts`
   Why it matters:
   - the code looks safe, but the automated coverage is stronger for config/runtime mode than for Windows autostart, kiosk behavior in packaged mode, power-manager no-op behavior, and operator diagnostics on Windows

### Low

4. Unix permission tightening appears in code paths that also run on Windows.
   Files:
   - `src/main/services/cert-manager.ts`
   Why it matters:
   - `chmodSync(0o600)` is harmless in practice on Windows, but it does not provide the same enforcement guarantees as on Unix
   Current assessment:
   - safe but security semantics differ; document this rather than treating it as a blocker

5. Linux-only power/display control is correctly gated and degrades safely, but the user-visible behavior on Windows still needs validation.
   Files:
   - `src/main/services/power-manager.ts`
   Current assessment:
   - `xset`/DPMS paths are Linux-only and guarded; Electron `powerSaveBlocker` should remain available on Windows

## Service Classification Summary

| Area | Classification | Notes |
| --- | --- | --- |
| Packaging config (`package.json`) | Windows-safe but untested | Windows NSIS target exists; native Windows packaging still needs execution |
| Runtime paths (`src/common/platform-paths.ts`) | Windows-safe | Explicit `APPDATA` app-data root; Linux legacy import is Linux-gated |
| Config (`src/common/config.ts`) | Windows-safe | `qa` and `production` no longer invent a fake backend IP |
| Main lifecycle (`src/main/index.ts`) | Windows-safe but untested | Kiosk/input policy is Electron-based, but native Windows behavior still needs validation |
| Runtime mode policy (`src/main/runtime-mode.ts`) | Windows-safe | Automated coverage exists |
| CLI (`src/main/cli.ts`, `src/main/cli-runner.ts`) | Windows-safe | Parsing coverage exists; packaged-mode CLI still needs native validation |
| Autostart (`src/main/services/autostart.ts`) | Windows-supported | Uses Electron login-item APIs for `win32` |
| Power manager (`src/main/services/power-manager.ts`) | Windows-degraded but safe | Linux `xset`/DPMS is gated; Electron power-save blocker should remain usable |
| Operator tools (`src/main/services/operator-tools.ts`) | Windows-safe but untested | Tooling is Node/Electron based; doctor still reports Linux dependency presence as optional signals |
| System stats (`src/main/services/telemetry/system-stats.ts`) | Windows-degraded but safe | Linux-only temperature is explicitly skipped outside Linux |
| Screenshot service (`src/main/services/screenshot-service.ts`) | Windows-safe but untested | Uses Electron page capture APIs |
| Cert manager (`src/main/services/cert-manager.ts`) | Windows-safe but untested | Pathing looks safe; Unix permission semantics differ on Windows |
| Pairing service (`src/main/services/pairing-service.ts`) | Windows-safe but untested | Network and cert flows look platform-neutral |
| HTTP/WebSocket clients | Windows-safe | No Linux assumptions observed |
| Cache/log/POP/schedule/snapshot/command services | Windows-safe | Filesystem and network based; no Linux-only hard dependency observed |
| Renderer playback (`src/renderer/*`) | Windows-safe but untested | Core DOM logic is cross-platform; webview/video/PDF behavior still needs native runtime validation |
| Legacy shell scripts/systemd unit | Linux-only and legacy | Not part of the supported Windows workflow |

## File Classification Appendix

### Root packaging and config

| File | Classification | Notes |
| --- | --- | --- |
| `package.json` | Windows-safe but untested | Windows NSIS packaging target exists; native Windows packaging still needs execution |
| `config.example.json` | Windows-safe | Example config aligns with IP-based backend contract |
| `config.json` | Windows-safe but environment-specific | Local runtime config, not a Windows blocker by itself |
| `tsconfig.json` | Windows-safe | Shared TypeScript config |
| `tsconfig.main.json` | Windows-safe | Main-process build config |
| `tsconfig.renderer.json` | Windows-safe | Renderer build config |
| `.mocharc.json` | Windows-safe | Test runner config only |

### `src/common/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/common/config.ts` | Windows-safe | Explicitly avoids fake backend defaults in `qa`/`production`; covered by automated tests |
| `src/common/logger.ts` | Windows-safe | File/logging behavior is platform-neutral in the audited paths |
| `src/common/media-compat.ts` | Windows-safe | Content/media classification is platform-neutral |
| `src/common/platform-paths.ts` | Windows-safe | Uses `APPDATA` on Windows; Linux legacy import is gated |
| `src/common/types.ts` | Windows-safe | Types only |
| `src/common/utils.ts` | Windows-safe but untested | Path-safe Node APIs; Windows filesystem semantics should still be exercised natively |

### `src/preload/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/preload/index.ts` | Windows-safe | IPC bridge only |

### `src/main/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/main/cli-runner.ts` | Windows-safe but untested | CLI bootstrap is Node/Electron based |
| `src/main/cli.ts` | Windows-safe | Parsing coverage exists |
| `src/main/index.ts` | Windows-safe but untested | Electron windowing/kiosk/webview policy; native Windows validation still required |
| `src/main/runtime-mode.ts` | Windows-safe | Automated coverage exists |

### `src/main/services/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/main/services/autostart.ts` | Windows-supported | Electron login-item path exists for `win32` |
| `src/main/services/cert-manager.ts` | Windows-safe but untested | Pathing is safe; `chmod` semantics differ on Windows |
| `src/main/services/command-processor.ts` | Windows-safe | Network/queue logic only |
| `src/main/services/device-state-store.ts` | Windows-safe | State persistence logic is platform-neutral |
| `src/main/services/lifecycle-events.ts` | Windows-safe | Event bookkeeping only |
| `src/main/services/log-shipper.ts` | Windows-safe | Log bundling/shipping is Node-based |
| `src/main/services/operator-tools.ts` | Windows-safe but untested | Commands are Node/Electron based; native Windows output still needs review |
| `src/main/services/pairing-service.ts` | Windows-safe but untested | Cert/network flow appears platform-neutral |
| `src/main/services/player-flow.ts` | Windows-safe | Orchestration logic only |
| `src/main/services/pop-service.ts` | Windows-safe | Disk spool logic appears path-safe |
| `src/main/services/power-manager.ts` | Windows-degraded but safe | Linux `xset` paths are gated; no hard Windows blocker found |
| `src/main/services/schedule-manager.ts` | Windows-safe | HTTP/snapshot logic only |
| `src/main/services/screenshot-service.ts` | Windows-safe but untested | Electron capture path must be exercised on Windows |
| `src/main/services/settings/default-media-service.ts` | Windows-safe | Network/state logic only |
| `src/main/services/settings/settings-client.ts` | Windows-safe | Network/state logic only |
| `src/main/services/snapshot-evaluator.ts` | Windows-safe | Pure logic |
| `src/main/services/snapshot-manager.ts` | Windows-safe | Snapshot caching/fetch logic only |
| `src/main/services/snapshot-parser.ts` | Windows-safe | Pure parsing logic |
| `src/main/services/telemetry/health-server.ts` | Windows-safe | Local HTTP service logic only |
| `src/main/services/telemetry/heartbeat.ts` | Windows-safe | Network/state logic only |
| `src/main/services/telemetry/system-stats.ts` | Windows-degraded but safe | Linux temperature path is gated |
| `src/main/services/telemetry/telemetry-service.ts` | Windows-safe | Composition/orchestration only |

### `src/main/services/network/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/main/services/network/http-client.ts` | Windows-safe | Platform-neutral HTTP client |
| `src/main/services/network/request-queue.ts` | Windows-safe | Queue/persistence logic only |
| `src/main/services/network/websocket-client.ts` | Windows-safe | Platform-neutral WebSocket client |

### `src/main/services/playback/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/main/services/playback/playback-engine.ts` | Windows-safe | Timeline/orchestration logic only |
| `src/main/services/playback/timeline-scheduler.ts` | Windows-safe | Pure timing logic |
| `src/main/services/playback/transition-manager.ts` | Windows-safe | Transition orchestration only |

### `src/renderer/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/renderer/default-media-player.ts` | Windows-safe but untested | DOM/media logic only; actual Windows playback must be exercised |
| `src/renderer/diagnostics.ts` | Windows-safe but untested | Renderer diagnostics UI is platform-neutral |
| `src/renderer/index.html` | Windows-safe | Static shell |
| `src/renderer/pairing.ts` | Windows-safe but untested | Renderer flow is platform-neutral; native packaging mode still needs validation |
| `src/renderer/player.ts` | Windows-safe but untested | Layout and playback orchestration need native Windows validation |
| `src/renderer/types.ts` | Windows-safe | Types only |
| `src/renderer/webpage-playback.js` | Windows-safe but untested | Tracked JS companion; Windows webview runtime still needs validation |
| `src/renderer/webpage-playback.ts` | Windows-safe but untested | Uses `<webview>`; needs native Windows validation |

### `scripts/`

| File | Classification | Notes |
| --- | --- | --- |
| `scripts/build-renderer.js` | Windows-safe | Build helper only |
| `scripts/copy-assets.js` | Windows-safe | Build helper only |
| `scripts/clear-cache.sh` | Linux-only and legacy | Not part of supported Windows flow |
| `scripts/collect-logs.sh` | Linux-only and legacy | Not part of supported Windows flow |
| `scripts/hexmon-player.service` | Linux-only and legacy | Systemd unit; not part of supported Windows flow |
| `scripts/pair-device.sh` | Linux-only and legacy | Legacy shell-based pairing flow |
| `scripts/postinstall.sh` | Linux-only and legacy | Legacy package/postinstall logic |
| `scripts/postremove.sh` | Linux-only and legacy | Legacy package/postremove logic |

### `test/`

| File | Classification | Notes |
| --- | --- | --- |
| `test/fault-injection/network-failures.test.ts` | Coverage present, not Windows-specific | Useful for resilience, not Windows-targeted |
| `test/fixtures/device-state.json` | Test fixture | Neutral |
| `test/fixtures/test-config.json` | Test fixture | Neutral |
| `test/helpers/test-utils.ts` | Coverage helper | Neutral |
| `test/integration/pairing-flow.test.ts` | Coverage present, not Windows-specific | Pairing logic coverage exists |
| `test/integration/runtime-mode-config.test.ts` | Coverage present, not Windows-specific | Useful for runtime-mode flow |
| `test/performance/resource-usage.test.ts` | Coverage present, not Windows-specific | Native Windows still needs separate runtime validation |
| `test/performance/timeline-jitter.test.ts` | Coverage present, not Windows-specific | Timing logic only |
| `test/setup.cjs` | Test helper | Neutral |
| `test/setup.ts` | Test helper | Neutral |
| `test/unit/common/config.test.ts` | Coverage present | Windows-relevant config fallback behavior covered |
| `test/unit/common/media-compat.test.ts` | Coverage present | Neutral |
| `test/unit/common/platform-paths.test.ts` | Coverage present | Windows-relevant runtime-root behavior covered |
| `test/unit/common/utils.test.ts` | Coverage present, not Windows-specific | No native Windows filesystem validation |
| `test/unit/main/cli.test.ts` | Coverage present | CLI parsing covered |
| `test/unit/main/runtime-mode.test.ts` | Coverage present | Kiosk policy logic covered |
| `test/unit/renderer/default-media-player.test.ts` | Coverage present, not Windows-specific | Runtime playback still needs native Windows validation |
| `test/unit/renderer/player-layout.test.ts` | Coverage present, not Windows-specific | Layout logic only |
| `test/unit/services/cache-manager.test.ts` | Coverage present, not Windows-specific | No native NTFS/AppData validation |
| `test/unit/services/command-processor.test.ts` | Coverage present, not Windows-specific | Neutral |
| `test/unit/services/default-media-service.test.ts` | Coverage present, not Windows-specific | Neutral |
| `test/unit/services/http-client.test.ts` | Coverage present, not Windows-specific | Neutral |
| `test/unit/services/playback-engine.test.ts` | Coverage present, not Windows-specific | Neutral |
| `test/unit/services/player-flow.test.ts` | Coverage present, not Windows-specific | Neutral |
| `test/unit/services/pop-service.test.ts` | Coverage present, not Windows-specific | Neutral |
| `test/unit/services/screenshot-service.test.ts` | Coverage present, not Windows-specific | Native Windows capture still unverified |
| `test/unit/services/settings-client.test.ts` | Coverage present, not Windows-specific | Neutral |
| `test/unit/services/snapshot-evaluator.test.ts` | Coverage present, not Windows-specific | Neutral |
| `test/unit/services/snapshot-manager.test.ts` | Coverage present, not Windows-specific | Neutral |
| `test/unit/services/snapshot-parser.test.ts` | Coverage present, not Windows-specific | Neutral |

### Operator-facing docs

| File | Classification | Notes |
| --- | --- | --- |
| `README.md` | Canonical and current | Best current entry point for cross-platform support |
| `PLATFORM_SUPPORT.md` | Canonical and current | Best current support-matrix doc |
| `UBUNTU_SETUP.md` | Ubuntu-specific, current | Correctly scoped to Ubuntu |
| `INSTALL.md` | Linux-heavy legacy/mixed | Should not be treated as the primary Windows path |
| `QUICKSTART.md` | Mixed; needs clearer scoping | Contains Linux-heavy packaging/install examples |
| `SECURITY.md` | Mixed; Linux path examples remain | Security model is useful, path examples are Linux-specific |
| `SETUP.md` | Linux-heavy legacy/mixed | Should not be treated as the primary Windows path |
| `TEST.md` | Mixed | Already notes that some cases are Linux-specific |
| `TROUBLESHOOTING.md` | Linux-heavy legacy/mixed | Must not be mistaken for the Windows operator guide |

## Remediation Backlog

### Must-fix before Windows release

- Execute the full checklist in `docs/windows-runtime-validation-checklist.md` on a real Windows 10/11 x64 machine or VM.
- Capture results for:
  - `npm run package:win`
  - NSIS install, upgrade, uninstall
  - first launch with missing backend config
  - packaged-mode CLI (`doctor`, `collect-logs`, `clear-cache`, pairing commands)
  - `qa` and `production` kiosk behavior
  - image, video, PDF, webpage playback
  - screenshot capture/upload
  - login-item autostart after sign-in/reboot
- If any Windows blocker appears during native validation, add a focused remediation issue before shipping Windows broadly.

### Should-fix

- Add automated unit coverage for Windows branches in:
  - `src/main/services/autostart.ts`
  - `src/main/services/power-manager.ts`
  - `src/main/services/operator-tools.ts`
  - `src/main/services/cert-manager.ts`
- Add at least one packaged-mode Windows smoke test or scripted validation harness if CI runner support becomes available.
- Review `QUICKSTART.md` so Windows packaging/install steps are separated more cleanly from Linux package examples.

### Docs/tests only

- Mark legacy shell scripts and `systemd` assets more explicitly as Ubuntu/Linux legacy support only.
- Add direct links from support docs to:
  - `docs/windows-compatibility-audit.md`
  - `docs/windows-feature-validation-matrix.md`
  - `docs/windows-runtime-validation-checklist.md`
- Keep `README.md` and `PLATFORM_SUPPORT.md` as the canonical Windows support entry points.

## Local Verification Recorded In This Audit

Commands run on the audit machine:

```bash
cd signage-screen
npm run build
npx mocha --config .mocharc.json \
  --spec 'test/unit/common/config.test.ts' \
  --spec 'test/unit/common/platform-paths.test.ts' \
  --spec 'test/unit/main/cli.test.ts' \
  --spec 'test/unit/main/runtime-mode.test.ts'
```

Observed result:

- build passed
- focused tests passed: 27/27

## Decision

Current recommendation: **treat Windows as implementation-ready but not yet release-signed-off** until the native Windows checklist is executed and recorded.
