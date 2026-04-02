# Ubuntu Compatibility Audit

## Summary

This audit answers the question: can `signage-screen` be packaged, installed, launched, paired, run in kiosk mode, autostart, play content, collect diagnostics, and degrade safely on Ubuntu without legacy Linux assumptions leaking into the supported runtime?

Static audit result: **largely yes for the supported Ubuntu desktop-session path**, with **no confirmed Ubuntu blocker found in the audited runtime code**, but **native Ubuntu packaging and runtime validation is still required before calling the Ubuntu path release-ready**.

Supported Ubuntu target for this audit:

- Ubuntu `22.04+`
- logged-in desktop session
- `.deb` and `AppImage`
- XDG autostart
- X11 as the primary display-power path
- Wayland as an accepted degraded path
- legacy `systemd` and `/etc/hexmon` style operations treated as compatibility-only, not the primary supported contract

Evidence gathered in this audit:

- Local TypeScript/Electron build passed: `npm run build`
- Focused Ubuntu-relevant automated tests passed:
  - `test/unit/common/config.test.ts`
  - `test/unit/common/platform-paths.test.ts`
  - `test/unit/main/cli.test.ts`
  - `test/unit/main/runtime-mode.test.ts`
  - `test/unit/services/screenshot-service.test.ts`
  - `test/unit/services/cache-manager.test.ts`
  - `test/unit/services/http-client.test.ts`
- `package.json` shows active `.deb` and `AppImage` packaging targets and desktop metadata
- No evidence was found that `postinstall.sh`, `postremove.sh`, or `hexmon-player.service` are wired into the current active Electron Builder packaging contract
- Native Ubuntu `.deb` packaging, `AppImage` packaging, install, autostart, X11 behavior, and Wayland behavior were **not** executed on a real Ubuntu machine in this audit session

This report is therefore a **static readiness audit plus validation plan**, not a final Ubuntu sign-off.

## Scope

Audited buckets:

- `src/common/`
- `src/main/`
- `src/renderer/`
- `src/preload/`
- `scripts/`
- packaging and root config:
  - `package.json`
  - `config.example.json`
  - `config.json`
  - `tsconfig*.json`
  - `.mocharc.json`
- `test/`
- operator-facing docs that affect Ubuntu packaging, install, or support behavior

## Findings

### High

1. Native Ubuntu packaging and runtime validation is still missing.
   Files/areas:
   - `package.json`
   - `src/main/index.ts`
   - `src/main/services/autostart.ts`
   - `src/main/services/power-manager.ts`
   - `src/renderer/webpage-playback.ts`
   - `src/main/services/screenshot-service.ts`
   Why it matters:
   - the code and package config align with the Ubuntu desktop-session contract, but there is no audit evidence here for:
     - `npm run package:deb`
     - `npm run package:appimage`
     - actual install/launch on Ubuntu
     - XDG autostart in a real desktop session
     - X11 `xset` capability behavior
     - Wayland degraded behavior
   Required before Ubuntu release:
   - run the checklist in `docs/ubuntu-runtime-validation-checklist.md` on Ubuntu 22.04 or 24.04

### Medium

2. Legacy Linux docs and shell/service assets are still prominent enough to mislead operators.
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
   - these assets still emphasize `systemd`, `/etc/hexmon`, `/var/lib/hexmon`, `/var/cache/hexmon`, and older Linux-only support workflows
   Current assessment:
   - the current supported Ubuntu path is desktop-session/XDG based, and the legacy assets appear to be compatibility leftovers rather than active packaging hooks

3. X11 and Wayland behavior intentionally diverge and need native validation.
   Files:
   - `src/main/services/power-manager.ts`
   - `src/main/services/operator-tools.ts`
   - `UBUNTU_SETUP.md`
   Why it matters:
   - X11 is the only path with `xset`/DPMS display-power control
   - Wayland is expected to degrade safely
   - the code looks aligned with that contract, but actual Ubuntu sessions still need to prove the behavior

4. Important Ubuntu branches remain only partially test-backed.
   Files:
   - `src/main/services/autostart.ts`
   - `src/main/services/power-manager.ts`
   - `src/main/services/operator-tools.ts`
   - `src/main/services/cert-manager.ts`
   Why it matters:
   - coverage is stronger for config/runtime pathing than for XDG autostart generation, X11/Wayland capability reporting, and Linux packaged-mode behavior

### Low

5. Linux legacy import is intentionally retained and must stay clearly scoped to upgrades only.
   Files:
   - `src/common/platform-paths.ts`
   Why it matters:
   - import from `/etc/hexmon`, `/var/lib/hexmon`, and `/var/cache/hexmon` is still supported on Linux, but only as a one-time migration path into the Electron runtime root
   Current assessment:
   - implementation is correctly Linux-gated and marker-based; native upgrade validation is still required

## Service Classification Summary

| Area | Classification | Notes |
| --- | --- | --- |
| Packaging config (`package.json`) | Ubuntu-safe but untested | `.deb` and `AppImage` targets are present; native Ubuntu packaging still needs execution |
| Runtime paths (`src/common/platform-paths.ts`) | Ubuntu-safe | Linux app-data root plus one-time legacy import model are explicit |
| Config (`src/common/config.ts`) | Ubuntu-safe | `qa` and `production` require explicit backend config |
| Main lifecycle (`src/main/index.ts`) | Ubuntu-safe but untested | Kiosk/input policy is Electron-based; native Ubuntu X11/Wayland validation still required |
| Runtime mode policy (`src/main/runtime-mode.ts`) | Ubuntu-safe | Automated coverage exists |
| CLI (`src/main/cli.ts`, `src/main/cli-runner.ts`) | Ubuntu-safe | Parsing coverage exists; packaged-mode CLI still needs native validation |
| Autostart (`src/main/services/autostart.ts`) | Ubuntu-supported | XDG desktop entry generation exists for Linux |
| Power manager (`src/main/services/power-manager.ts`) | Ubuntu-degraded but intentional | X11 `xset` path exists; Wayland/no-`xset` path degrades cleanly |
| Operator tools (`src/main/services/operator-tools.ts`) | Ubuntu-safe but untested | Doctor/collect-logs/clear-cache are Node/Electron based; native Ubuntu output still needs validation |
| System stats (`src/main/services/telemetry/system-stats.ts`) | Ubuntu-safe but sensor-dependent | Linux-only temperature path is present and guarded against failure |
| Screenshot service (`src/main/services/screenshot-service.ts`) | Ubuntu-safe but untested | Electron capture path needs native validation |
| Cert manager (`src/main/services/cert-manager.ts`) | Ubuntu-safe but untested | Linux pathing and permission model align with expectations; packaged-mode validation still needed |
| Pairing service (`src/main/services/pairing-service.ts`) | Ubuntu-safe but untested | Network and cert flow appear platform-neutral |
| HTTP/WebSocket clients | Ubuntu-safe | No Ubuntu-specific blocker found |
| Cache/log/POP/schedule/snapshot/command services | Ubuntu-safe | Filesystem and network based; align with Linux runtime-root model |
| Renderer playback (`src/renderer/*`) | Ubuntu-safe but untested | Core DOM logic is cross-platform; actual Ubuntu media/webview behavior still needs native validation |
| Legacy shell scripts/systemd unit | legacy-only | Not part of the supported Ubuntu desktop-session workflow |

## File Classification Appendix

### Root packaging and config

| File | Classification | Notes |
| --- | --- | --- |
| `package.json` | Ubuntu-safe but untested | Active Linux `.deb` and `AppImage` targets plus desktop metadata are present |
| `config.example.json` | Ubuntu-safe | Example config aligns with current backend IP contract |
| `config.json` | Ubuntu-safe but environment-specific | Local runtime config, not an Ubuntu blocker by itself |
| `tsconfig.json` | Ubuntu-safe | Shared TypeScript config |
| `tsconfig.main.json` | Ubuntu-safe | Main-process build config |
| `tsconfig.renderer.json` | Ubuntu-safe | Renderer build config |
| `.mocharc.json` | Ubuntu-safe | Test runner config only |

### `src/common/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/common/config.ts` | Ubuntu-safe | Explicit backend config behavior is correct for `qa`/`production`; covered by tests |
| `src/common/logger.ts` | Ubuntu-safe | Logging behavior is platform-neutral in the audited paths |
| `src/common/media-compat.ts` | Ubuntu-safe | Media classification is platform-neutral |
| `src/common/platform-paths.ts` | Ubuntu-safe | Linux runtime root and one-time legacy import are explicit and Linux-gated |
| `src/common/types.ts` | Ubuntu-safe | Types only |
| `src/common/utils.ts` | Ubuntu-safe but untested | File/path helpers look Linux-safe; native package/runtime validation still needed |

### `src/preload/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/preload/index.ts` | Ubuntu-safe | IPC bridge only |

### `src/main/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/main/cli-runner.ts` | Ubuntu-safe but untested | CLI bootstrap is Node/Electron based |
| `src/main/cli.ts` | Ubuntu-safe | Parsing coverage exists |
| `src/main/index.ts` | Ubuntu-safe but untested | Electron windowing/kiosk/webview behavior needs native Ubuntu validation |
| `src/main/runtime-mode.ts` | Ubuntu-safe | Automated coverage exists |

### `src/main/services/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/main/services/autostart.ts` | Ubuntu-supported | XDG autostart desktop entry generation exists; AppImage exec-path handling is explicit |
| `src/main/services/cert-manager.ts` | Ubuntu-safe but untested | Linux pathing and file-permission model align with expectations |
| `src/main/services/command-processor.ts` | Ubuntu-safe | Queue/network logic only |
| `src/main/services/device-state-store.ts` | Ubuntu-safe | State persistence logic is platform-neutral |
| `src/main/services/lifecycle-events.ts` | Ubuntu-safe | Event bookkeeping only |
| `src/main/services/log-shipper.ts` | Ubuntu-safe | Log bundling/shipping is Node-based |
| `src/main/services/operator-tools.ts` | Ubuntu-safe but untested | Node/Electron diagnostics path is supported; native Ubuntu output still needs validation |
| `src/main/services/pairing-service.ts` | Ubuntu-safe but untested | Cert/network flow appears platform-neutral |
| `src/main/services/player-flow.ts` | Ubuntu-safe | Orchestration logic only |
| `src/main/services/pop-service.ts` | Ubuntu-safe | Disk spool logic appears path-safe for Ubuntu runtime-root use |
| `src/main/services/power-manager.ts` | Ubuntu-degraded but intentional | X11 `xset` path exists; Wayland/no-`xset` degrades by design |
| `src/main/services/schedule-manager.ts` | Ubuntu-safe | HTTP/snapshot logic only |
| `src/main/services/screenshot-service.ts` | Ubuntu-safe but untested | Electron capture path must be exercised on Ubuntu |
| `src/main/services/settings/default-media-service.ts` | Ubuntu-safe | Network/state logic only |
| `src/main/services/settings/settings-client.ts` | Ubuntu-safe | Network/state logic only |
| `src/main/services/snapshot-evaluator.ts` | Ubuntu-safe | Pure logic |
| `src/main/services/snapshot-manager.ts` | Ubuntu-safe | Snapshot caching/fetch logic only |
| `src/main/services/snapshot-parser.ts` | Ubuntu-safe | Pure parsing logic |
| `src/main/services/telemetry/health-server.ts` | Ubuntu-safe | Local HTTP service logic only |
| `src/main/services/telemetry/heartbeat.ts` | Ubuntu-safe | Network/state logic only |
| `src/main/services/telemetry/system-stats.ts` | Ubuntu-safe but untested | Linux system metrics path exists; failure path appears safe |
| `src/main/services/telemetry/telemetry-service.ts` | Ubuntu-safe | Composition/orchestration only |

### `src/main/services/network/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/main/services/network/http-client.ts` | Ubuntu-safe | Platform-neutral HTTP client |
| `src/main/services/network/request-queue.ts` | Ubuntu-safe | Queue/persistence logic only |
| `src/main/services/network/websocket-client.ts` | Ubuntu-safe | Platform-neutral WebSocket client |

### `src/main/services/playback/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/main/services/playback/playback-engine.ts` | Ubuntu-safe | Timeline/orchestration logic only |
| `src/main/services/playback/timeline-scheduler.ts` | Ubuntu-safe | Pure timing logic |
| `src/main/services/playback/transition-manager.ts` | Ubuntu-safe | Transition orchestration only |

### `src/renderer/`

| File | Classification | Notes |
| --- | --- | --- |
| `src/renderer/default-media-player.ts` | Ubuntu-safe but untested | DOM/media logic only; actual Ubuntu playback must be exercised |
| `src/renderer/diagnostics.ts` | Ubuntu-safe but untested | Renderer diagnostics UI is platform-neutral |
| `src/renderer/index.html` | Ubuntu-safe | Static shell |
| `src/renderer/pairing.ts` | Ubuntu-safe but untested | Renderer flow is platform-neutral; native Ubuntu packaged-mode validation still needed |
| `src/renderer/player.ts` | Ubuntu-safe but untested | Layout and playback orchestration need native Ubuntu validation |
| `src/renderer/types.ts` | Ubuntu-safe | Types only |
| `src/renderer/webpage-playback.js` | Ubuntu-safe but untested | Tracked JS companion; native Ubuntu webview behavior still needs validation |
| `src/renderer/webpage-playback.ts` | Ubuntu-safe but untested | Uses `<webview>`; needs native Ubuntu validation |

### `scripts/`

| File | Classification | Notes |
| --- | --- | --- |
| `scripts/build-renderer.js` | Ubuntu-safe | Build helper only |
| `scripts/copy-assets.js` | Ubuntu-safe | Build helper only |
| `scripts/clear-cache.sh` | legacy-only | Older Linux shell workflow; not part of the supported Node/Electron operator path |
| `scripts/collect-logs.sh` | legacy-only | Older Linux shell workflow; not part of the supported Node/Electron operator path |
| `scripts/hexmon-player.service` | legacy-only | Systemd unit; not part of the supported Ubuntu desktop-session model |
| `scripts/pair-device.sh` | legacy-only | Legacy shell-based pairing path |
| `scripts/postinstall.sh` | legacy-only | Older package/postinstall flow; no active packaging hook found in `package.json` |
| `scripts/postremove.sh` | legacy-only | Older package/postremove flow |

### `test/`

| File | Classification | Notes |
| --- | --- | --- |
| `test/fault-injection/network-failures.test.ts` | Coverage present, not Ubuntu-specific | Useful for resilience, not desktop-session specific |
| `test/fixtures/device-state.json` | Test fixture | Neutral |
| `test/fixtures/test-config.json` | Test fixture | Neutral |
| `test/helpers/test-utils.ts` | Coverage helper | Neutral |
| `test/integration/pairing-flow.test.ts` | Coverage present, not Ubuntu-specific | Pairing logic coverage exists |
| `test/integration/runtime-mode-config.test.ts` | Coverage present, not Ubuntu-specific | Useful for runtime-mode flow |
| `test/performance/resource-usage.test.ts` | Coverage present, not Ubuntu-specific | Native Ubuntu package/runtime still needs separate validation |
| `test/performance/timeline-jitter.test.ts` | Coverage present, not Ubuntu-specific | Timing logic only |
| `test/setup.cjs` | Test helper | Neutral |
| `test/setup.ts` | Test helper | Neutral |
| `test/unit/common/config.test.ts` | Coverage present | Ubuntu-relevant config behavior covered |
| `test/unit/common/media-compat.test.ts` | Coverage present | Neutral |
| `test/unit/common/platform-paths.test.ts` | Coverage present | Linux runtime-root and legacy import behavior covered |
| `test/unit/common/utils.test.ts` | Coverage present, not Ubuntu-specific | No native Ubuntu desktop-session validation |
| `test/unit/main/cli.test.ts` | Coverage present | CLI parsing covered |
| `test/unit/main/runtime-mode.test.ts` | Coverage present | Kiosk policy logic covered |
| `test/unit/renderer/default-media-player.test.ts` | Coverage present, not Ubuntu-specific | Runtime playback still needs native Ubuntu validation |
| `test/unit/renderer/player-layout.test.ts` | Coverage present, not Ubuntu-specific | Layout logic only |
| `test/unit/services/cache-manager.test.ts` | Coverage present | Linux filesystem/cache behavior is partially exercised |
| `test/unit/services/command-processor.test.ts` | Coverage present, not Ubuntu-specific | Neutral |
| `test/unit/services/default-media-service.test.ts` | Coverage present, not Ubuntu-specific | Neutral |
| `test/unit/services/http-client.test.ts` | Coverage present | HTTP client behavior partially exercised |
| `test/unit/services/playback-engine.test.ts` | Coverage present, not Ubuntu-specific | Neutral |
| `test/unit/services/player-flow.test.ts` | Coverage present, not Ubuntu-specific | Neutral |
| `test/unit/services/pop-service.test.ts` | Coverage present, not Ubuntu-specific | Neutral |
| `test/unit/services/screenshot-service.test.ts` | Coverage present | Screenshot service flow partially exercised |
| `test/unit/services/settings-client.test.ts` | Coverage present, not Ubuntu-specific | Neutral |
| `test/unit/services/snapshot-evaluator.test.ts` | Coverage present, not Ubuntu-specific | Neutral |
| `test/unit/services/snapshot-manager.test.ts` | Coverage present, not Ubuntu-specific | Neutral |
| `test/unit/services/snapshot-parser.test.ts` | Coverage present, not Ubuntu-specific | Neutral |

### Operator-facing docs

| File | Classification | Notes |
| --- | --- | --- |
| `README.md` | Canonical and current | Best cross-platform entry point |
| `PLATFORM_SUPPORT.md` | Canonical and current | Best support-matrix doc |
| `UBUNTU_SETUP.md` | Canonical and current | Best Ubuntu step-by-step guide |
| `INSTALL.md` | Mixed / legacy-heavy | Should not be treated as the primary Ubuntu support contract |
| `QUICKSTART.md` | Mixed | Contains Linux build/install examples but not the cleanest production path |
| `SECURITY.md` | Mixed | Security model is useful; path examples remain legacy-Linux heavy |
| `SETUP.md` | Mixed / legacy-heavy | Should not be treated as the primary Ubuntu contract |
| `TEST.md` | Mixed | Contains useful test notes, some Linux-specific |
| `TROUBLESHOOTING.md` | Mixed / legacy-heavy | Must not be mistaken for the primary Ubuntu support guide |

## Remediation Backlog

### Must-fix before Ubuntu release

- Execute the full checklist in `docs/ubuntu-runtime-validation-checklist.md` on a real Ubuntu 22.04 or 24.04 machine or VM.
- Capture results for:
  - `npm run package:deb`
  - `npm run package:appimage`
  - fresh `.deb` install
  - fresh `AppImage` launch
  - first launch with missing backend config
  - packaged-mode CLI (`doctor`, `collect-logs`, `clear-cache`, pairing commands)
  - `qa` and `production` kiosk behavior
  - image, video, PDF, webpage playback
  - screenshot capture/upload
  - XDG autostart after logout/login or reboot
  - X11 `xset` capability path
  - Wayland/no-`xset` degraded path
  - upgrade and uninstall behavior
  - one-time legacy Linux import path
- If any Ubuntu blocker appears during native validation, add a focused remediation issue before shipping Ubuntu broadly.

### Should-fix

- Add automated unit coverage for Linux-specific branches in:
  - `src/main/services/autostart.ts`
  - `src/main/services/power-manager.ts`
  - `src/main/services/operator-tools.ts`
  - `src/main/services/cert-manager.ts`
- Add at least one Ubuntu packaging smoke check in CI if a Linux desktop-capable runner becomes available.
- Make the distinction between:
  - supported Ubuntu desktop-session path
  - legacy `systemd`/old-path compatibility assets
  more obvious in mixed docs such as `INSTALL.md`, `SETUP.md`, and `TROUBLESHOOTING.md`.

### Docs/tests only

- Keep `README.md`, `PLATFORM_SUPPORT.md`, and `UBUNTU_SETUP.md` as the canonical Ubuntu entry points.
- Add direct support links to:
  - `docs/ubuntu-compatibility-audit.md`
  - `docs/ubuntu-feature-validation-matrix.md`
  - `docs/ubuntu-runtime-validation-checklist.md`
- Mark legacy shell scripts and `hexmon-player.service` more explicitly as legacy-only.

## Local Verification Recorded In This Audit

Commands run on the audit machine:

```bash
cd signage-screen
npm run build
npx mocha --config .mocharc.json \
  --spec 'test/unit/common/config.test.ts' \
  --spec 'test/unit/common/platform-paths.test.ts' \
  --spec 'test/unit/main/cli.test.ts' \
  --spec 'test/unit/main/runtime-mode.test.ts' \
  --spec 'test/unit/services/screenshot-service.test.ts' \
  --spec 'test/unit/services/cache-manager.test.ts' \
  --spec 'test/unit/services/http-client.test.ts'
```

Observed result:

- build passed
- focused tests passed: 41/41

## Decision

Current recommendation: **treat Ubuntu as implementation-ready for the supported desktop-session model, but not yet release-signed-off** until the native Ubuntu checklist is executed and recorded on real Ubuntu X11 and Wayland environments.
