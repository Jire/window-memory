// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// What Window Memory remembers, and the file it is kept in.
//
// The file is ~/.local/state/window-memory/windows.json:
//
//   {
//     "version": 1,
//     "apps": {
//       "org.gnome.TextEditor.desktop": {
//         "windows": [
//           {
//             "id": "…", "title": "…", "wmClass": "…", "role": "…",
//             "lastSeen": 1762851234567,
//             "layouts": {
//               "<monitor layout key>": {
//                 "mon": "<monitor id>", "rx": 40, "ry": 30, "w": 1200, "h": 800,
//                 "max": 0, "ws": 0, "t": 1762851234567
//               }
//             }
//           }
//         ]
//       }
//     }
//   }
//
// Each app keeps a few window "slots". A window that opens takes over the
// best-matching slot that no open window is using, so an app's main window
// reopens where its main window last was, and its second window where the
// second one was. Each slot holds one geometry per monitor layout, so the
// same window can live in different places when docked and undocked.
//
// Positions are stored relative to the monitor the window was on ("mon",
// "rx", "ry"), which keeps them right when monitors are rearranged.
// "max" holds Meta.MaximizeFlags; w/h/rx/ry are the size and position the
// window had when it was last not fully maximized.
//
// This file is also imported by prefs.js, so it must not use Shell modules.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const FORMAT_VERSION = 1;
const MAX_WINDOWS_PER_APP = 8;
const MAX_LAYOUTS_PER_WINDOW = 8;
const FORGET_AFTER_MS = 180 * 24 * 60 * 60 * 1000;
const WRITE_DELAY_MS = 1500;

export function stateFilePath() {
    return GLib.build_filenamev(
        [GLib.get_user_state_dir(), 'window-memory', 'windows.json']);
}

/** Reads the state file. Returns empty state if it is missing or unreadable. */
export function readStateFile() {
    try {
        const [, bytes] = GLib.file_get_contents(stateFilePath());
        const data = JSON.parse(new TextDecoder().decode(bytes));
        if (data?.version === FORMAT_VERSION && data.apps && typeof data.apps === 'object')
            return data;
        console.warn('[window-memory] Ignoring state file with unknown format');
    } catch (e) {
        if (!(e instanceof GLib.Error && e.matches(GLib.FileError, GLib.FileError.NOENT)))
            console.warn(`[window-memory] Could not read state file: ${e.message}`);
    }
    return {version: FORMAT_VERSION, apps: {}};
}

function sameRecord(a, b) {
    if (!a || !b)
        return false;
    for (const k of ['mon', 'rx', 'ry', 'w', 'h', 'max', 'ws']) {
        if (a[k] !== b[k])
            return false;
    }
    return true;
}

export class WindowStore {
    constructor() {
        this._data = readStateFile();
        this._writeId = 0;
        this._writing = false;
        this._dirty = false;
        this._prune();
    }

    /**
     * Finds the slot a newly opened window should use, or makes a new one.
     *
     * @param {string} appKey
     * @param {{title: string, wmClass: string, role: string}} info
     * @param {Set<object>} inUse slots that open windows already have
     * @returns {{entry: object, isNew: boolean}}
     */
    claim(appKey, info, inUse) {
        const app = (this._data.apps[appKey] ??= {windows: []});
        const now = Date.now();

        let best = null, bestScore = -1;
        for (const e of app.windows) {
            if (inUse.has(e))
                continue;
            // Different X11 roles or WM classes within one app are different
            // kinds of window (a toolbox vs. a document window); never mix them.
            if (e.role !== info.role || e.wmClass !== info.wmClass)
                continue;
            const score = info.title && e.title === info.title ? 1 : 0;
            if (score > bestScore || (score === bestScore && e.lastSeen > best.lastSeen)) {
                best = e;
                bestScore = score;
            }
        }

        if (best) {
            best.title = info.title;
            best.lastSeen = now;
            this._changed();
            return {entry: best, isNew: false};
        }

        const entry = {
            id: GLib.uuid_string_random(),
            title: info.title,
            wmClass: info.wmClass,
            role: info.role,
            lastSeen: now,
            layouts: {},
        };
        app.windows.push(entry);

        // Drop the longest-unused slots no open window holds.
        while (app.windows.length > MAX_WINDOWS_PER_APP) {
            let oldest = -1;
            app.windows.forEach((e, i) => {
                if (e !== entry && !inUse.has(e) &&
                    (oldest < 0 || e.lastSeen < app.windows[oldest].lastSeen))
                    oldest = i;
            });
            if (oldest < 0)
                break;
            app.windows.splice(oldest, 1);
        }

        this._changed();
        return {entry, isNew: true};
    }

    /**
     * The geometry to restore a slot to under the given monitor layout: the
     * one saved for that exact layout if there is one, otherwise the most
     * recently saved one from any layout.
     */
    geometryFor(entry, layoutKey) {
        const exact = entry.layouts[layoutKey];
        if (exact)
            return exact;
        let newest = null;
        for (const rec of Object.values(entry.layouts)) {
            if (!newest || rec.t > newest.t)
                newest = rec;
        }
        return newest;
    }

    exactGeometryFor(entry, layoutKey) {
        return entry.layouts[layoutKey] ?? null;
    }

    /** Saves a slot's geometry for a layout. Returns false if nothing changed. */
    setGeometry(entry, layoutKey, rec) {
        if (sameRecord(entry.layouts[layoutKey], rec))
            return false;
        entry.layouts[layoutKey] = rec;

        const keys = Object.keys(entry.layouts);
        if (keys.length > MAX_LAYOUTS_PER_WINDOW) {
            keys.sort((a, b) => entry.layouts[a].t - entry.layouts[b].t);
            for (const k of keys.slice(0, keys.length - MAX_LAYOUTS_PER_WINDOW))
                delete entry.layouts[k];
        }
        this._changed();
        return true;
    }

    /** Called when a window using this slot closes. */
    release(entry) {
        entry.lastSeen = Date.now();
        this._changed();
    }

    /** Forgets one app, or everything for "*". */
    forget(appKey) {
        if (appKey === '*')
            this._data.apps = {};
        else
            delete this._data.apps[appKey];
        this._changed();
    }

    /** Writes any pending changes right away, synchronously. */
    flush() {
        if (this._writeId) {
            GLib.source_remove(this._writeId);
            this._writeId = 0;
        }
        if (!this._dirty)
            return;
        try {
            this._ensureDir();
            GLib.file_set_contents(stateFilePath(), this._serialize());
            this._dirty = false;
        } catch (e) {
            console.error(e, '[window-memory] Could not save state');
        }
    }

    destroy() {
        this.flush();
    }

    _prune() {
        const cutoff = Date.now() - FORGET_AFTER_MS;
        for (const [key, app] of Object.entries(this._data.apps)) {
            app.windows = (app.windows ?? []).filter(e =>
                e && e.lastSeen >= cutoff && e.layouts && typeof e.layouts === 'object');
            if (!app.windows.length)
                delete this._data.apps[key];
        }
    }

    _changed() {
        this._dirty = true;
        if (this._writeId || this._writing)
            return;
        this._writeId = GLib.timeout_add(GLib.PRIORITY_LOW, WRITE_DELAY_MS, () => {
            this._writeId = 0;
            this._writeAsync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _serialize() {
        return JSON.stringify(this._data);
    }

    _ensureDir() {
        const dir = GLib.path_get_dirname(stateFilePath());
        GLib.mkdir_with_parents(dir, 0o700);
    }

    _writeAsync() {
        if (!this._dirty)
            return;
        try {
            this._ensureDir();
        } catch (e) {
            console.error(e, '[window-memory] Could not create state directory');
            return;
        }
        this._dirty = false;
        this._writing = true;
        const bytes = new GLib.Bytes(new TextEncoder().encode(this._serialize()));
        const file = Gio.File.new_for_path(stateFilePath());
        // Writes to a temporary file and renames it, so a crash mid-write
        // never leaves a truncated file behind.
        file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null, (f, res) => {
                this._writing = false;
                try {
                    f.replace_contents_finish(res);
                } catch (e) {
                    console.error(e, '[window-memory] Could not save state');
                    this._dirty = true;
                }
                if (this._dirty)
                    this._changed();
            });
    }
}
