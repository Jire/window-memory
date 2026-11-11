// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Window Memory
//
// Remembers each app window's position, size, monitor, maximized state and
// (optionally) workspace, and restores them when the window opens again.
//
// On Wayland an app can't place its own windows, so the compositor has to do
// it. That's what this extension does: it watches every normal app window,
// saves where it is whenever it's moved or resized, and when a window of the
// same app opens later, moves it back before you'd notice.
//
// It also handles the "every window piled onto one screen" problem: when the
// monitor setup changes (a monitor sleeps, wakes, is unplugged or comes back
// after suspend), Mutter shuffles windows onto the remaining screens. While
// that's happening nothing is recorded, and once the setup settles, every
// window that has a saved place for that exact setup is moved back to it.
//
// See store.js for how windows are matched to what was saved, and
// monitors.js for how monitor setups are identified.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {readMonitorLayout} from './monitors.js';
import {WindowStore} from './store.js';

// Wait this long after a window stops moving before recording where it is.
const SAVE_DELAY_MS = 400;
// After restoring a window, keep putting it back for this long if the app
// moves or resizes it itself (Electron and browsers like to do this while
// starting up). Stops early as soon as you grab the window.
const SETTLE_MS = 2000;
const VERIFY_DELAY_MS = 150;
const MAX_REAPPLIES = 4;
// After a monitor change, let Mutter finish moving windows before we restore.
const MONITOR_SETTLE_MS = 750;
// Record nothing until the monitor setup has been stable for this long, so a
// monitor flickering off and on during resume can't overwrite saved places.
const MONITOR_FREEZE_MS = 3000;
// A restored window is left exactly where it was saved if at least this much
// of its top edge is on some screen; otherwise it's pulled fully on-screen.
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 40;
const MAX_WORKSPACE_INDEX = 35;

const BOTH = Meta.MaximizeFlags.BOTH;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/** Per-window bookkeeping: timers, the saved slot it uses, and what phase it's in. */
class TrackedWindow {
    constructor(win) {
        this.win = win;
        this.actor = null;
        this.appKey = null;
        this.entry = null;
        // 'waiting'   - opened, waiting for its first frame
        // 'settling'  - just restored, re-applying if the app moves it
        // 'recording' - saving every move/resize
        this.phase = 'waiting';
        this.started = false;
        this.target = null;
        this.expect = null;
        this.reapplies = 0;
        this._timers = new Map();
    }

    setTimer(name, ms, fn) {
        this.clearTimer(name);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(name);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.set(name, id);
    }

    clearTimer(name) {
        const id = this._timers.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timers.delete(name);
        }
    }

    hasTimer(name) {
        return this._timers.has(name);
    }

    destroy() {
        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();
        this.win.disconnectObject(this);
        this.actor?.disconnectObject(this);
        this.actor = null;
    }
}

export default class WindowMemory extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._debug = this._settings.get_boolean('debug');
        this._store = new WindowStore();
        this._layout = readMonitorLayout();
        this._tracked = new Map();
        this._timers = new Map();
        this._frozen = false;

        this._settings.connectObject(
            'changed::debug', () => (this._debug = this._settings.get_boolean('debug')),
            'changed::forget-apps', () => this._processForgetRequests(),
            'changed::ignored-apps', () => this._dropIgnoredWindows(),
            this);
        global.display.connectObject(
            'window-created', (_display, win) => this._onWindowCreated(win),
            'grab-op-begin', (_display, win) => this._onGrabBegin(win),
            this);
        global.backend.get_monitor_manager().connectObject(
            'monitors-changing', () => this._freeze(),
            'monitors-changed', () => this._onMonitorsChanged(),
            this);

        this._processForgetRequests();

        // Windows that are already open (the extension was just turned on or
        // reloaded) stay where they are; we only start recording them.
        for (const actor of global.get_window_actors())
            this._adopt(actor.get_meta_window());

        this._log(`enabled, monitor layout: ${this._layout.key}`);
    }

    disable() {
        for (const tw of this._tracked.values()) {
            if (tw.hasTimer('snapshot'))
                this._snapshot(tw);
            tw.destroy();
        }
        this._tracked.clear();

        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();

        global.backend.get_monitor_manager().disconnectObject(this);
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);

        this._store.destroy();
        this._store = null;
        this._settings = null;
        this._layout = null;
    }

    // ---- Window lifecycle -------------------------------------------------

    _onWindowCreated(win) {
        if (this._tracked.has(win))
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;

        const tw = new TrackedWindow(win);
        this._tracked.set(win, tw);
        win.connectObject('unmanaging', () => this._onUnmanaging(tw), tw);

        // Once the window is shown, the app has set its title, app id, type
        // and parent, and Mutter has done its own placement, which we then
        // override. 'shown' fires even when the window isn't painted (in the
        // Overview, on another workspace); first-frame is a fallback.
        const start = () => {
            if (tw.phase !== 'waiting' || tw.started)
                return;
            tw.started = true;
            actor.disconnectObject(tw);
            tw.actor = null;
            this._begin(tw, true);
        };
        tw.actor = actor;
        actor.connectObject('first-frame', start, tw);
        win.connectObject('shown', start, tw);
    }

    _adopt(win) {
        if (!win || this._tracked.has(win))
            return;
        const tw = new TrackedWindow(win);
        this._tracked.set(win, tw);
        win.connectObject('unmanaging', () => this._onUnmanaging(tw), tw);
        this._begin(tw, false);
    }

    _begin(tw, restore) {
        const win = tw.win;
        const appKey = this._isManageable(win) ? this._appKey(win) : null;
        if (!appKey || this._ignoredApps().has(appKey)) {
            this._untrack(tw);
            return;
        }

        tw.appKey = appKey;
        const {entry, isNew} =
            this._store.claim(appKey, this._describe(win), this._entriesInUse());
        tw.entry = entry;

        const onChange = () => this._onGeometryChanged(tw);
        win.connectObject(
            'position-changed', onChange,
            'size-changed', onChange,
            'notify::maximized-horizontally', onChange,
            'notify::maximized-vertically', onChange,
            'notify::fullscreen', onChange,
            'workspace-changed', onChange,
            tw);

        const exact = this._store.exactGeometryFor(entry, this._layout.key);
        const rec = restore && !isNew
            ? exact ?? this._store.geometryFor(entry, this._layout.key) : null;

        if (!rec) {
            this._log(`${appKey}: ${isNew ? 'new window' : 'tracking'} "${win.get_title()}"`);
            tw.phase = 'recording';
            this._scheduleSnapshot(tw);
            return;
        }

        this._log(`${appKey}: restoring "${win.get_title()}" to ${JSON.stringify(rec)}` +
            (exact ? '' : ' (from another monitor layout)'));
        tw.phase = 'settling';
        tw.target = {rec, exact: !!exact};
        tw.reapplies = 0;
        tw.expect = this._apply(win, rec, {
            exact: !!exact,
            workspace: this._settings.get_boolean('restore-workspace'),
        });
        tw.setTimer('settle', SETTLE_MS, () => this._endSettle(tw));
    }

    _onGeometryChanged(tw) {
        if (tw.phase === 'settling')
            tw.setTimer('verify', VERIFY_DELAY_MS, () => this._verify(tw));
        else if (tw.phase === 'recording')
            this._scheduleSnapshot(tw);
    }

    /** The app moved or resized a window we just restored; put it back. */
    _verify(tw) {
        if (tw.phase !== 'settling' || this._satisfied(tw.win, tw.expect))
            return;
        if (tw.reapplies >= MAX_REAPPLIES) {
            this._log(`${tw.appKey}: app keeps changing its window, giving up`);
            this._endSettle(tw);
            return;
        }
        tw.reapplies++;
        this._log(`${tw.appKey}: app moved its window, restoring again (${tw.reapplies})`);
        tw.expect = this._apply(tw.win, tw.target.rec, {exact: tw.target.exact, workspace: false});
    }

    _endSettle(tw) {
        if (tw.phase !== 'settling')
            return;
        tw.clearTimer('settle');
        tw.clearTimer('verify');
        tw.phase = 'recording';
        tw.target = tw.expect = null;
        this._scheduleSnapshot(tw);
    }

    _onGrabBegin(win) {
        // You're moving or resizing it: you win over the restore.
        const tw = win && this._tracked.get(win);
        if (tw?.phase === 'settling')
            this._endSettle(tw);
    }

    _onUnmanaging(tw) {
        if (tw.hasTimer('snapshot'))
            this._snapshot(tw);
        if (tw.entry)
            this._store.release(tw.entry);
        this._untrack(tw);
    }

    _untrack(tw) {
        tw.destroy();
        this._tracked.delete(tw.win);
    }

    // ---- Recording --------------------------------------------------------

    _scheduleSnapshot(tw) {
        if (this._frozen || tw.phase !== 'recording')
            return;
        tw.setTimer('snapshot', SAVE_DELAY_MS, () => this._snapshot(tw));
    }

    _snapshot(tw) {
        tw.clearTimer('snapshot');
        if (this._frozen || !tw.entry || tw.phase !== 'recording')
            return;

        const win = tw.win;
        const layout = this._layout;
        const mon = layout.monitors[win.get_monitor()];
        if (!mon)
            return;

        // While maximized or fullscreen, keep the size and position the window
        // will go back to, from this layout if we have it, or from anywhere.
        const prev = this._store.exactGeometryFor(tw.entry, layout.key) ??
            this._store.geometryFor(tw.entry, layout.key);
        const max = win.get_maximize_flags();
        const fullscreen = win.is_fullscreen();

        const rec = {
            mon: mon.id,
            rx: prev?.rx, ry: prev?.ry, w: prev?.w, h: prev?.h,
            max: fullscreen ? prev?.max ?? 0 : max,
            ws: win.is_on_all_workspaces() ? -1 : win.get_workspace()?.index() ?? -1,
            t: Date.now(),
        };
        if (!fullscreen && max !== BOTH) {
            const f = win.get_frame_rect();
            rec.rx = f.x - mon.x;
            rec.ry = f.y - mon.y;
            rec.w = f.width;
            rec.h = f.height;
        }

        if (this._store.setGeometry(tw.entry, layout.key, rec))
            this._log(`${tw.appKey}: saved ${JSON.stringify(rec)}`);
    }

    // ---- Restoring --------------------------------------------------------

    /**
     * Moves a window to a saved geometry. Returns what the window should look
     * like afterwards, so _satisfied() can tell if the app undid it.
     */
    _apply(win, rec, {exact, workspace}) {
        const layout = this._layout;
        const mon = layout.byId.get(rec.mon) ??
            layout.monitors[win.get_monitor()] ??
            layout.monitors[global.display.get_primary_monitor()];
        if (!mon)
            return null;

        if (workspace)
            this._moveToWorkspace(win, rec.ws);

        const moveToMonitor = () => {
            if (win.get_monitor() !== mon.index)
                win.move_to_monitor(mon.index);
        };

        // Fullscreen apps (games, video players) only get put on the right screen.
        if (win.is_fullscreen()) {
            moveToMonitor();
            return null;
        }

        const curMax = win.get_maximize_flags();
        const wantMax = this._settings.get_boolean('restore-maximized') ? rec.max ?? 0 : curMax;

        // Already maximized the way we want (the app did it itself): just
        // make sure it's on the right screen, without an unmaximize flicker.
        if (curMax !== 0 && curMax === wantMax) {
            moveToMonitor();
            return {max: wantMax, rect: null, monitor: mon.index};
        }

        let rect = null;
        if (rec.w > 0 && rec.h > 0 && Number.isFinite(rec.rx) && Number.isFinite(rec.ry)) {
            rect = {x: mon.x + rec.rx, y: mon.y + rec.ry, w: rec.w, h: rec.h};
            // Saved on the monitor we're about to use, in this exact setup?
            // Then trust it; otherwise make it fit the screen it lands on.
            const sameSetup = exact && layout.byId.get(rec.mon) === mon;
            rect = this._fitOnScreen(win, rect, mon, !sameSetup);
        }

        if (curMax !== 0)
            win.unmaximize();

        const resize = win.allows_resize();
        if (rect && win.allows_move()) {
            if (!resize) {
                const f = win.get_frame_rect();
                rect.w = f.width;
                rect.h = f.height;
            }
            win.move_resize_frame(false, rect.x, rect.y, rect.w, rect.h);
        } else {
            moveToMonitor();
        }

        if (wantMax !== 0) {
            if (wantMax === BOTH)
                win.maximize();
            else
                win.set_maximize_flags(wantMax);
            // On Wayland the move above only lands once the app acks the new
            // size, so the window may have been maximized on its old screen.
            moveToMonitor();
        }

        return {max: wantMax, rect, resize, monitor: mon.index};
    }

    /** Whether a window still looks the way _apply() left it. */
    _satisfied(win, expect) {
        if (!expect || win.is_fullscreen())
            return true;
        const max = win.get_maximize_flags();
        if (max !== expect.max)
            return false;
        if (expect.monitor !== undefined && win.get_monitor() !== expect.monitor)
            return false;
        if (max === BOTH || !expect.rect)
            return true;

        const f = win.get_frame_rect();
        const r = expect.rect;
        const near = (a, b) => Math.abs(a - b) <= 2;
        const xOk = (max & Meta.MaximizeFlags.HORIZONTAL) ||
            (near(f.x, r.x) && (!expect.resize || near(f.width, r.w)));
        const yOk = (max & Meta.MaximizeFlags.VERTICAL) ||
            (near(f.y, r.y) && (!expect.resize || near(f.height, r.h)));
        return !!(xOk && yOk);
    }

    /**
     * Keeps a restored window reachable. With `force`, the window is also
     * shrunk and moved to fit fully inside `mon` (used when the monitor setup
     * differs from the one the geometry was saved in).
     */
    _fitOnScreen(win, rect, mon, force) {
        if (!force) {
            const grabbable = this._layout.monitors.some(m => {
                if (!m)
                    return false;
                const wa = win.get_work_area_for_monitor(m.index);
                const left = Math.max(rect.x, wa.x);
                const right = Math.min(rect.x + rect.w, wa.x + wa.width);
                return right - left >= MIN_VISIBLE_WIDTH &&
                    rect.y >= wa.y && rect.y <= wa.y + wa.height - MIN_VISIBLE_HEIGHT;
            });
            if (grabbable)
                return rect;
        }

        const wa = win.get_work_area_for_monitor(mon.index);
        const w = Math.min(rect.w, wa.width);
        const h = Math.min(rect.h, wa.height);
        return {
            x: clamp(rect.x, wa.x, wa.x + wa.width - w),
            y: clamp(rect.y, wa.y, wa.y + wa.height - h),
            w, h,
        };
    }

    _moveToWorkspace(win, index) {
        if (!Number.isInteger(index) || index < 0 || index > MAX_WORKSPACE_INDEX ||
            win.is_on_all_workspaces())
            return;
        const manager = global.workspace_manager;
        for (let n = manager.get_n_workspaces(); n <= index; n++)
            manager.append_new_workspace(false, 0);
        if (index < manager.get_n_workspaces())
            win.change_workspace_by_index(index, false);
    }

    // ---- Monitor changes --------------------------------------------------

    /** Stops recording until the monitor setup has been stable for a while. */
    _freeze() {
        this._frozen = true;
        for (const tw of this._tracked.values())
            tw.clearTimer('snapshot');
        this._setTimer('unfreeze', MONITOR_FREEZE_MS, () => {
            this._frozen = false;
            this._log('monitor setup stable, recording again');
            // Record where everything ended up, now under the new layout.
            for (const tw of this._tracked.values())
                this._scheduleSnapshot(tw);
        });
    }

    _onMonitorsChanged() {
        this._freeze();
        const oldKey = this._layout.key;
        this._layout = readMonitorLayout();
        if (this._layout.key === oldKey)
            return;

        this._log(`monitor layout changed: ${this._layout.key}`);
        if (this._settings.get_boolean('follow-monitor-changes'))
            this._setTimer('restoreAll', MONITOR_SETTLE_MS, () => this._restoreAll());
        else
            this._clearTimer('restoreAll');
    }

    /** Moves every open window back to where it was the last time this monitor setup was used. */
    _restoreAll() {
        let count = 0;
        for (const tw of this._tracked.values()) {
            if (!tw.entry || tw.phase === 'waiting')
                continue;
            const rec = this._store.exactGeometryFor(tw.entry, this._layout.key);
            if (!rec)
                continue;
            if (tw.phase === 'settling')
                this._endSettle(tw);
            this._apply(tw.win, rec, {exact: true, workspace: false});
            count++;
        }
        this._log(`restored ${count} window(s) for this monitor layout`);
    }

    // ---- Settings ---------------------------------------------------------

    _processForgetRequests() {
        const keys = this._settings.get_strv('forget-apps');
        if (!keys.length)
            return;

        for (const key of keys) {
            this._log(`forgetting ${key === '*' ? 'everything' : key}`);
            this._store.forget(key);
            // Open windows of that app start over with a fresh slot.
            for (const tw of this._tracked.values()) {
                if (!tw.entry || (key !== '*' && tw.appKey !== key))
                    continue;
                tw.entry = null;
                tw.entry = this._store.claim(tw.appKey, this._describe(tw.win),
                    this._entriesInUse()).entry;
                this._scheduleSnapshot(tw);
            }
        }
        this._settings.set_strv('forget-apps', []);
        this._store.flush();
    }

    _dropIgnoredWindows() {
        const ignored = this._ignoredApps();
        for (const tw of [...this._tracked.values()]) {
            if (tw.appKey && ignored.has(tw.appKey))
                this._untrack(tw);
        }
    }

    // ---- Helpers ----------------------------------------------------------

    /** Only regular top-level app windows; not dialogs, popups, splash screens… */
    _isManageable(win) {
        return win.get_window_type() === Meta.WindowType.NORMAL &&
            !win.get_transient_for() &&
            !win.is_override_redirect() &&
            !win.is_skip_taskbar();
    }

    /** A stable name for the app a window belongs to. */
    _appKey(win) {
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        // Apps without a .desktop file get a made-up id that changes every
        // time, so fall back to the window's class for those.
        if (app && !app.is_window_backed())
            return app.get_id();
        const cls = win.get_sandboxed_app_id() || win.get_wm_class() ||
            win.get_gtk_application_id();
        return cls ? `wmclass:${cls}` : null;
    }

    _describe(win) {
        return {
            title: win.get_title() ?? '',
            wmClass: win.get_wm_class() ?? '',
            role: win.get_role() ?? '',
        };
    }

    _entriesInUse() {
        const set = new Set();
        for (const tw of this._tracked.values()) {
            if (tw.entry)
                set.add(tw.entry);
        }
        return set;
    }

    _ignoredApps() {
        return new Set(this._settings.get_strv('ignored-apps'));
    }

    _setTimer(name, ms, fn) {
        this._clearTimer(name);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(name);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.set(name, id);
    }

    _clearTimer(name) {
        const id = this._timers.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timers.delete(name);
        }
    }

    _log(msg) {
        if (this._debug)
            console.log(`[window-memory] ${msg}`);
    }
}
