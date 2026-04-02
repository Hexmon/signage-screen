# Ubuntu Runtime Validation Checklist

Use this checklist on a real Ubuntu `22.04` or `24.04` machine or VM. Record each step as `pass`, `degraded but acceptable`, `fail`, or `blocked`.

## Test Host Prerequisites

- Ubuntu `22.04 LTS` or `24.04 LTS`
- Desktop session login available
- Node.js `20 LTS`
- npm
- Git
- backend reachable over LAN/IP
- one X11 desktop session
- one Wayland desktop session, or one machine where both modes can be exercised

## Build And Package

1. Clone the player repo on the Ubuntu machine.
2. Install dependencies.
3. Build the app.
4. Build the `.deb`.
5. Build the `AppImage`.

Commands:

```bash
cd signage-screen
npm install
npm run clean
npm run build
npm run package:deb
npm run package:appimage
```

Expected result:

- `build/` contains a `.deb`
- `build/` contains an `AppImage`
- packaging completes without requiring `systemd`

Failure hints:

- if packaging depends on legacy shell/service wiring, treat that as a regression against the supported desktop-session contract

## Fresh `.deb` Install

1. Install the generated `.deb`.
2. Launch the app from the desktop session.

Commands:

```bash
sudo dpkg -i build/*.deb
sudo apt-get install -f
hexmon-signage-player
```

Expected result:

- app launches successfully
- app does not depend on `systemd` to run
- runtime root is created under the Electron user-data directory

## Fresh `AppImage` Launch

1. Mark the `AppImage` executable.
2. Launch it from the desktop session.

Commands:

```bash
chmod +x build/*.AppImage
./build/*.AppImage
```

Expected result:

- app launches successfully
- runtime root is created under the Electron user-data directory
- later XDG autostart `Exec=` points at the `AppImage` path when launched from AppImage

## First Launch With No Backend Config

1. Ensure no explicit backend config is present.
2. Launch the app in the desktop session.

Expected result:

- the app stays in configuration-required or pairing-ready state
- no fake backend IP is invented
- the app does not crash or exit immediately

## Runtime Paths

Run:

```bash
hexmon-signage-player doctor
```

Check:

- `paths.runtimeRoot` points to the Electron app-data directory
- `paths.cachePath` and `paths.certDir` are inside that runtime root unless explicitly overridden
- config, cache, certs, logs, screenshots, and spool directories are writable

Expected result:

- runtime data uses the supported per-user Electron runtime root

## CLI / Operator Tools

Run:

```bash
hexmon-signage-player doctor
hexmon-signage-player clear-cache
hexmon-signage-player collect-logs
hexmon-signage-player pair request
```

Expected result:

- commands run without relying on the old shell scripts
- output paths are valid inside the current runtime root
- `doctor` reports:
  - `autostart.strategy = linux-xdg-autostart`
  - X11/Wayland capability differences appropriately

## Pairing And Certificates

1. Configure backend IP values.
2. Launch the player.
3. Pair with a real backend using a valid pairing code.
4. Confirm device registration appears in CMS.
5. Relaunch the app and confirm pairing persists.

Expected result:

- pairing succeeds
- certificates are written to the runtime cert directory
- relaunch reuses the stored device identity

## Kiosk Behavior

Validate both `qa` and `production` runtime modes.

Checks:

- app opens fullscreen
- locked-mode interaction policy behaves as intended
- relaunch after crash preserves lock policy
- launching a second instance focuses the first instance
- multi-monitor/display enumeration is safe

Expected result:

- behavior matches the intended Ubuntu desktop-session kiosk contract

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

## Screenshot And Diagnostics

1. Trigger screenshot capture through the supported path.
2. Confirm the image is saved and, where applicable, uploaded.
3. Run log collection again and inspect the output bundle.

Expected result:

- screenshots are captured successfully
- diagnostics bundle includes expected logs and metadata

## XDG Autostart

After the GUI app has launched once in `qa` or `production`, check:

```bash
ls -l ~/.config/autostart/hexmon-signage-player.desktop
cat ~/.config/autostart/hexmon-signage-player.desktop
```

Expected result:

- the desktop entry exists
- `Exec=` points at the installed binary or `AppImage` path

Then validate after logout/login or reboot:

- app starts automatically in the user session

## Upgrade

1. Install an older `.deb` or run an older `AppImage`.
2. Pair/configure the device.
3. Upgrade to the newer package.

Expected result:

- app upgrades cleanly
- config and pairing state remain intact unless intentionally migrated

## Uninstall

1. Uninstall the `.deb` package if using `.deb`.
2. Record what remains in the runtime root.

Expected result:

- only intended runtime state remains or is removed according to product policy
- the supported desktop-session flow does not depend on `systemd`

## Legacy Linux Import Validation

Only for upgrade validation:

Populate one or more of:

- `/etc/hexmon/config.json`
- `/var/lib/hexmon/certs`
- `/var/cache/hexmon`

Then start the player with no explicit `HEXMON_*` path overrides.

Expected result:

- the player imports legacy config/certs/cache once
- the runtime root contains `.legacy-linux-imported.json`
- future launches do not repeat the import

## X11 Validation

On Ubuntu X11 with `xset` available:

```bash
hexmon-signage-player doctor
which xset
```

Expected result:

- `display.capabilities.dpmsControl` is `true`
- `display.capabilities.preventBlanking` is `true`

## Wayland Validation

On Ubuntu Wayland, or when `xset` is unavailable:

```bash
hexmon-signage-player doctor
```

Expected result:

- the player still starts
- `display.capabilities.dpmsControl` is `false`
- `display.capabilities.preventBlanking` is `false`
- display enumeration still works through Electron when available

## Record Sheet

Use this minimal record for each execution:

| Step | Result | Notes |
| --- | --- | --- |
| Build/package `.deb` |  |  |
| Build/package `AppImage` |  |  |
| Fresh `.deb` install |  |  |
| Fresh `AppImage` launch |  |  |
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
| XDG autostart |  |  |
| Upgrade |  |  |
| Uninstall |  |  |
| Legacy import |  |  |
| X11 path |  |  |
| Wayland path |  |  |

## Exit Criteria

Ubuntu is ready for broader rollout only when:

- no blocker is found in packaging, install, startup, pairing, kiosk, or playback
- `.deb` and `AppImage` flows both succeed
- X11 and Wayland behaviors match the supported contract
- the supported desktop-session path does not rely on the legacy `systemd` model
- any degraded but acceptable behavior is explicitly documented
