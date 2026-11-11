#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# Builds dist/<uuid>.shell-extension.zip from extension/, with the settings
# schema compiled so the zip also works when it's simply unpacked.
# Install the result with:  ./install.sh --zip dist/*.shell-extension.zip
set -euo pipefail
cd "$(dirname "$0")/.."

command -v glib-compile-schemas >/dev/null 2>&1 ||
    { echo "error: glib-compile-schemas not found (package glib2 / libglib2.0-bin / glib2-devel)" >&2; exit 1; }

uuid=$(python3 -c 'import json; print(json.load(open("extension/metadata.json"))["uuid"])')
out="dist/$uuid.shell-extension.zip"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cp -r extension/. "$stage/"
rm -f "$stage/schemas/gschemas.compiled"
glib-compile-schemas --strict "$stage/schemas"

mkdir -p dist
rm -f "$out"
if command -v zip >/dev/null 2>&1; then
    (cd "$stage" && zip -qr -X "$OLDPWD/$out" .)
else
    python3 - "$stage" "$out" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(stage):
        for f in sorted(files):
            path = os.path.join(root, f)
            z.write(path, os.path.relpath(path, stage))
PY
fi
echo "$out"
