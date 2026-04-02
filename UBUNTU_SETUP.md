# Ubuntu Setup And Verification

This is the current supported production path for the player on Ubuntu:

- Ubuntu 22.04 LTS or newer
- Logged-in desktop session
- `.deb` or `AppImage` install
- XDG autostart

For the current Ubuntu audit findings and native validation matrix, also use:

- [docs/ubuntu-compatibility-audit.md](./docs/ubuntu-compatibility-audit.md)
- [docs/ubuntu-feature-validation-matrix.md](./docs/ubuntu-feature-validation-matrix.md)
- [docs/ubuntu-runtime-validation-checklist.md](./docs/ubuntu-runtime-validation-checklist.md)

## 1. Install

`.deb`:

```bash
sudo dpkg -i hexmon-signage-player_1.0.0_amd64.deb
sudo apt-get install -f
```

`AppImage`:

```bash
chmod +x HexmonSignage-Player-1.0.0.AppImage
./HexmonSignage-Player-1.0.0.AppImage
```

## 2. First Launch

Launch the player once from the desktop session:

```bash
hexmon-signage-player
```

Expected result:

- the player starts in the configured runtime mode
- the runtime root is created under the Electron user-data directory
- config, cache, and cert directories become user-writable

## 3. Verify Runtime Paths

Run:

```bash
hexmon-signage-player doctor
```

Check:

- `paths.runtimeRoot` points to the Electron app-data directory
- `paths.cachePath` and `paths.certDir` are inside that runtime root unless overridden
- `autostart.strategy` is `linux-xdg-autostart`

## 4. Verify Pairing Flow

Fresh install:

```bash
hexmon-signage-player pair request
hexmon-signage-player pair submit ABC123
```

Check:

- `pair request` returns a device id and pairing code
- `pair submit` returns the device id and fingerprint
- certificate files are created in the runtime cert directory

## 5. Verify Autostart

After the GUI app has launched once in `qa` or `production` mode, check:

```bash
ls -l ~/.config/autostart/hexmon-signage-player.desktop
cat ~/.config/autostart/hexmon-signage-player.desktop
```

Expected result:

- the desktop entry exists
- `Exec=` points at the installed binary or AppImage path

## 6. Verify Cache And Support Commands

```bash
hexmon-signage-player collect-logs
hexmon-signage-player clear-cache
hexmon-signage-player doctor
```

Check:

- `collect-logs` returns a `bundleDir`
- `clear-cache` returns the removed cache targets
- `doctor` still succeeds after cache clearing

## 7. Legacy Linux Import Case

Only for upgrading from the old Linux layout:

Populate one or more of:

- `/etc/hexmon/config.json`
- `/var/lib/hexmon/certs`
- `/var/cache/hexmon`

Then start the player with no explicit `HEXMON_*` path overrides.

Expected result:

- the player imports legacy config/certs/cache once
- the runtime root contains `.legacy-linux-imported.json`
- future launches do not repeat the import

## 8. X11 Case

On Ubuntu X11 with `xset` available:

```bash
hexmon-signage-player doctor
which xset
```

Expected result:

- `display.capabilities.dpmsControl` is `true`
- `display.capabilities.preventBlanking` is `true`

## 9. Wayland Or No `xset` Case

On Ubuntu Wayland, or when `xset` is unavailable:

```bash
hexmon-signage-player doctor
```

Expected result:

- the player still starts
- `display.capabilities.dpmsControl` is `false`
- `display.capabilities.preventBlanking` is `false`
- display enumeration still works through Electron when the desktop session exposes displays

## 10. Upgrade / Regression Checklist

After every Ubuntu release or player package change, verify:

1. Fresh install from `.deb`
2. Fresh launch from `AppImage`
3. Pairing request/submit
4. Image, video, PDF, webpage playback
5. Screenshot capture/upload
6. `collect-logs`
7. `clear-cache`
8. XDG autostart after logout/login or reboot
9. Legacy Linux import on an upgraded machine
10. X11 and Wayland behavior

## Notes

- Ubuntu production support is a desktop-session install, not a systemd service.
- Display power control is intentionally X11-only and degrades cleanly on Wayland.
- Use [PLATFORM_SUPPORT.md](./PLATFORM_SUPPORT.md) for the support contract and [README.md](./README.md) for the main player overview.
