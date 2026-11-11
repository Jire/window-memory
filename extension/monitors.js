// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Describes the current monitor setup in a way that survives restarts.
//
// Mutter numbers monitors 0, 1, 2… and those numbers change whenever a
// monitor comes or goes, so they can't be stored. Instead each monitor gets
// an id from its EDID (vendor/product/serial), the same thing Windows and
// macOS key their display settings on. If two connected monitors report the
// same EDID (identical models with no serial), the connector name is added to
// tell them apart.
//
// The layout key names every monitor with its position and size. Window
// positions are saved per layout key, so each monitor setup remembers its own
// arrangement.

/**
 * @typedef {object} MonitorInfo
 * @property {number} index  Mutter's monitor index (for get_monitor() etc.)
 * @property {string} id     stable id, see above
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 *
 * @typedef {object} MonitorLayout
 * @property {string} key
 * @property {MonitorInfo[]} monitors   indexed by Mutter's monitor index
 * @property {Map<string, MonitorInfo>} byId
 */

/** @returns {MonitorLayout} */
export function readMonitorLayout() {
    const manager = global.backend.get_monitor_manager();

    const logical = manager.get_logical_monitors().map(lm => ({
        index: lm.get_number(),
        parts: lm.get_monitors().map(m => ({
            connector: m.get_connector() ?? '',
            edid: [m.get_vendor(), m.get_product(), m.get_serial()]
                .map(s => (s ?? '').trim()).join('/'),
        })),
    }));

    const edidCount = new Map();
    for (const lm of logical) {
        for (const p of lm.parts)
            edidCount.set(p.edid, (edidCount.get(p.edid) ?? 0) + 1);
    }

    const monitors = [];
    const byId = new Map();
    for (const lm of logical) {
        // A logical monitor holds several physical ones when mirroring.
        const id = lm.parts.map(p =>
            p.edid === '//' || edidCount.get(p.edid) > 1
                ? `${p.edid}@${p.connector}` : p.edid).sort().join('+');
        const geo = global.display.get_monitor_geometry(lm.index);
        const info = {
            index: lm.index, id,
            x: geo.x, y: geo.y, width: geo.width, height: geo.height,
        };
        monitors[lm.index] = info;
        byId.set(id, info);
    }

    const key = [...byId.values()]
        .map(m => `${m.id}=${m.x},${m.y},${m.width}x${m.height}`)
        .sort().join(' ');

    return {key, monitors, byId};
}
