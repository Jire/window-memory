# AGENTS.md

Guidance for AI coding assistants (Claude Code, Codex, Copilot, Cursor and others) working in this repository or helping someone install or use it.

## What this is

Window Memory is a GNOME Shell extension (GJS, ES modules) that remembers each app window's position, size, monitor and maximized state, and restores them when the window opens again. It also moves windows back after monitor changes (a monitor sleeping, waking, being unplugged or coming back after suspend). On Wayland, apps can't place their own windows, so this has to happen in the compositor.

- UUID: `window-memory@jire.github.io`
- Supported GNOME Shell: 49–51. Tested on 51. 49 and 50 expose the same Mutter APIs (checked against Mutter's headers) but haven't been run.
- License: GPL-2.0-or-later

## Helping someone install it

Point them to the one-line installer in [README.md](README.md#install). It installs per user (never with `sudo`). On Wayland the extension loads at the next login. To load it without logging out, use the Looking Glass line in the README. Settings: `gnome-extensions prefs window-memory@jire.github.io`.

If windows aren't being restored, have them turn on **Debug logging** in the settings and run `journalctl --user -f -g window-memory` while they open and move a window.

## Layout

| Path | Purpose |
| --- | --- |
| `extension/` | Everything that ships in the extension zip |
| `extension/extension.js` | Window tracking, restoring, recording, monitor-change handling |
| `extension/store.js` | Saved-state format, window-to-slot matching, the JSON file in `~/.local/state/window-memory/`. Also imported by `prefs.js`, so it must not import Shell modules |
| `extension/monitors.js` | Identifies monitors by EDID and builds the per-setup layout key |
| `extension/prefs.js` | Preferences window (libadwaita) |
| `extension/schemas/` | GSettings schema. Compiled by `scripts/build.sh`; don't commit `gschemas.compiled` |
| `scripts/hot-load.js` | Looking Glass loader for reloading without logging out. Not shipped in the extension zip; `install.sh` puts it in `~/.local/share/window-memory/` |
| `install.sh` | User-facing installer (curl/wget pipe), also `--uninstall`, `--purge`, `--version`, `--zip` |
| `scripts/build.sh` | Builds `dist/<uuid>.shell-extension.zip` |
| `.github/workflows/ci.yml` | Syntax check, ESLint, schema check, ShellCheck, build; publishes a release on `v*` tags |

## How it works, briefly

- A window is handled once Mutter emits `shown` for it (with the actor's `first-frame` as a fallback): only `NORMAL` windows with no parent that aren't skip-taskbar.
- Each app (keyed by its `.desktop` id, or `wmclass:<class>` for apps without one) has up to 8 window slots. A new window takes the unused slot with the same WM class and X11 role, preferring a matching title, then the most recently closed.
- Each slot stores one geometry per monitor layout. Positions are relative to the monitor (by EDID), so rearranging monitors doesn't break them.
- For 2 s after restoring, if the app moves or resizes its own window, it's put back (up to 4 times). Grabbing the window ends this early.
- On `monitors-changing` / `monitors-changed`, recording pauses until the setup has been stable for 3 s, and windows with a saved geometry for the new layout are moved back to it.
- On Wayland, `move_resize_frame()` only lands once the client acks the new size, so `_apply()` calls `move_to_monitor()` again after maximizing.

## Conventions

- Every `connect` needs a matching `disconnect` (use `connectObject` / `disconnectObject`), and `disable()` must undo everything `enable()` did, including timers.
- Don't move a window the user is dragging, and never move windows that were already open when the extension was enabled. Unlocking the screen or reloading must not rearrange anything.
- Use only Mutter API that exists in every supported GNOME version (49+: `get_maximize_flags()`, `maximize()` / `unmaximize()` with no arguments, `set_maximize_flags()`).
- Start new source files with the SPDX header used in the existing files.
- Logging during normal operation goes through `_log()`, which only logs when the `debug` setting is on.

## Checking changes

```bash
npx --yes eslint@9 .
shellcheck install.sh scripts/*.sh
scripts/build.sh && ./install.sh --zip dist/*.shell-extension.zip
```

Then reload with the Looking Glass line from the README. Reloading the user's live session is their call, so ask before suggesting it.

To test without touching the live session, run a headless shell on a private D-Bus session with isolated `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_STATE_HOME`:

```bash
dbus-run-session -- gnome-shell --headless --wayland --no-x11 --wayland-display wm-test \
    --virtual-monitor 1920x1080 --virtual-monitor 1280x1024
```

Start GTK test windows with `WAYLAND_DISPLAY=wm-test`. To drive the shell over `org.gnome.Shell.Eval`, enable a throwaway extension that sets `global.context.unsafe_mode = true`. To simulate unplugging a monitor, call `org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig` with method 1 (temporary) and only one logical monitor.

## Releasing

Tag and push (`git tag -a vN -m vN && git push origin vN`). CI builds the zip and attaches it to the GitHub release, and the installer always fetches `releases/latest`. Don't add a `version` key to `metadata.json`: extensions.gnome.org sets it. When a new GNOME version comes out, check the Mutter APIs above, test, then add it to `shell-version`.

Everything shipped in `extension/` must pass the [extensions.gnome.org review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html). Keep it free of build or dev files. The `unlock-dialog` session mode is deliberate: monitors often disconnect while the screen is locked, and the extension has to keep tracking through that. It has no UI on the lock screen. Say so in the review notes when submitting.
