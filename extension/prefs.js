// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {readStateFile} from './store.js';

function appInfoFor(appKey) {
    if (appKey.startsWith('wmclass:'))
        return null;
    try {
        return GioUnix.DesktopAppInfo.new(appKey);
    } catch {
        return null;
    }
}

export default class WindowMemoryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: 'Window Memory',
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(page);

        // ---- Behaviour
        const behaviour = new Adw.PreferencesGroup({
            title: 'Restoring',
            description: 'Windows always come back at the same position and size, on the same monitor.',
        });
        page.add(behaviour);

        const switches = [
            ['restore-maximized', 'Restore maximized state',
                'Maximize a window again if it was maximized when it closed'],
            ['restore-workspace', 'Restore workspace',
                'Move a window back to the workspace it was on when it closed'],
            ['follow-monitor-changes', 'Put windows back after monitor changes',
                'When a monitor sleeps, wakes, is unplugged or plugged back in, move windows back to where they were in that monitor setup'],
        ];
        for (const [key, title, subtitle] of switches) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            behaviour.add(row);
        }

        // ---- Remembered apps
        const apps = new Adw.PreferencesGroup({
            title: 'Apps',
            description: 'Turn an app off to leave its windows alone.',
        });
        page.add(apps);

        const forgetAll = new Gtk.Button({
            label: 'Forget All',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        apps.set_header_suffix(forgetAll);

        const state = readStateFile();
        const ignored = new Set(settings.get_strv('ignored-apps'));
        const keys = new Set([...Object.keys(state.apps), ...ignored]);

        const entries = [...keys].map(key => {
            const info = appInfoFor(key);
            return {
                key,
                info,
                name: info?.get_name() ?? key.replace(/^wmclass:/, '').replace(/\.desktop$/, ''),
                count: state.apps[key]?.windows?.length ?? 0,
            };
        }).sort((a, b) => a.name.localeCompare(b.name));

        const placeholder = new Adw.ActionRow({
            title: 'No windows remembered yet',
            subtitle: 'Open, move or resize some windows and they will show up here.',
            sensitive: false,
        });
        const rows = [];
        const updatePlaceholder = () => {
            placeholder.visible = rows.every(r => !r.visible);
        };

        const forget = key => {
            const pending = settings.get_strv('forget-apps');
            if (!pending.includes(key))
                settings.set_strv('forget-apps', [...pending, key]);
        };

        for (const entry of entries) {
            const subtitleFor = enabled => {
                if (!enabled)
                    return 'Ignored';
                if (!entry.count)
                    return 'Nothing remembered';
                return entry.count === 1 ? '1 window remembered' : `${entry.count} windows remembered`;
            };

            const row = new Adw.ActionRow({
                title: entry.name,
                subtitle: subtitleFor(!ignored.has(entry.key)),
                tooltip_text: entry.key,
            });
            const gicon = entry.info?.get_icon();
            row.add_prefix(gicon
                ? new Gtk.Image({gicon, pixel_size: 32})
                : new Gtk.Image({icon_name: 'application-x-executable', pixel_size: 32}));

            const forgetButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Forget this app’s windows',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                sensitive: entry.count > 0,
            });
            forgetButton.connect('clicked', () => {
                forget(entry.key);
                entry.count = 0;
                forgetButton.sensitive = false;
                row.subtitle = subtitleFor(toggle.active);
                if (toggle.active)
                    row.visible = false;
                updatePlaceholder();
            });

            const toggle = new Gtk.Switch({
                active: !ignored.has(entry.key),
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Remember this app’s windows',
            });
            toggle.connect('notify::active', () => {
                const list = new Set(settings.get_strv('ignored-apps'));
                if (toggle.active)
                    list.delete(entry.key);
                else
                    list.add(entry.key);
                settings.set_strv('ignored-apps', [...list]);
                row.subtitle = subtitleFor(toggle.active);
            });

            row.add_suffix(forgetButton);
            row.add_suffix(toggle);
            row.activatable_widget = toggle;
            apps.add(row);
            rows.push(row);
        }
        apps.add(placeholder);
        updatePlaceholder();
        forgetAll.sensitive = entries.some(e => e.count > 0);

        forgetAll.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: 'Forget all windows?',
                body: 'Every saved window position and size will be deleted. Windows that are open now will be remembered again from where they are.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('forget', 'Forget All');
            dialog.set_response_appearance('forget', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, response) => {
                if (response !== 'forget')
                    return;
                forget('*');
                forgetAll.sensitive = false;
                for (const row of rows) {
                    const key = row.tooltip_text;
                    if (!ignored.has(key) && !new Set(settings.get_strv('ignored-apps')).has(key))
                        row.visible = false;
                }
                updatePlaceholder();
            });
            dialog.present(window);
        });

        // ---- Troubleshooting
        const advanced = new Adw.PreferencesGroup({title: 'Troubleshooting'});
        page.add(advanced);
        const debug = new Adw.SwitchRow({
            title: 'Debug logging',
            subtitle: 'Log what is saved and restored (journalctl --user -f -g window-memory)',
        });
        settings.bind('debug', debug, 'active', Gio.SettingsBindFlags.DEFAULT);
        advanced.add(debug);
    }
}
