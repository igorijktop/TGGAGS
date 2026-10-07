#!/usr/bin/env bash
# Exercises the Windows installer for real, under Wine on Linux: silent install → check files, shortcuts and
# registry → silent uninstall → check the clean-up. Needs: wine64 + wine32 (apt install wine64 wine32:i386), xvfb.
#   bash tests/e2e/installer-wine.sh [release/TGGAGS-IDE-Setup.exe]
set -euo pipefail
INSTALLER=$(realpath "${1:-release/TGGAGS-IDE-Setup.exe}")
export WINEPREFIX=${WINEPREFIX:-/tmp/tgg-wineprefix} WINEARCH=win64 WINEDEBUG=-all
WINE=${WINE:-/usr/lib/wine/wine64}
APP="$WINEPREFIX/drive_c/users/$USER/AppData/Local/Programs/TGGAGS IDE"
ok() { echo "  ✓ $1"; }; bad() { echo "  ✗ $1"; exit 1; }
rm -rf "$WINEPREFIX"; xvfb-run -a "$WINE" wineboot --init >/dev/null 2>&1 || true

echo "install"
xvfb-run -a "$WINE" "$INSTALLER" /S >/dev/null 2>&1 || bad "installer exited with an error"
[ -f "$APP/TGGAGS IDE.exe" ] && ok "TGGAGS IDE.exe installed" || bad "TGGAGS IDE.exe missing"
for f in resources/app.asar resources.pak icudtl.dat ffmpeg.dll Uninstall.exe resources/app.asar.unpacked/dist-electron/ts-worker.cjs resources/app.asar.unpacked/node_modules/typescript/lib/typescript.js; do
  [ -e "$APP/$f" ] && ok "$f" || bad "$f missing"; done
[ "$(head -c2 "$APP/TGGAGS IDE.exe")" = "MZ" ] && ok "executable is a PE file" || bad "executable is not a PE file"
KEY='HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\TGGAGS-IDE'
xvfb-run -a "$WINE" reg query "$KEY" 2>/dev/null | grep -q "DisplayName.*TGGAGS IDE" && ok "uninstall entry registered (Settings → Apps)" || bad "uninstall entry missing"
find "$WINEPREFIX/drive_c/users" -name "TGGAGS IDE.lnk" | grep -q Start && ok "Start menu shortcut" || bad "Start menu shortcut missing"
find "$WINEPREFIX/drive_c/users" -name "TGGAGS IDE.lnk" | grep -q Desktop && ok "desktop shortcut" || bad "desktop shortcut missing"
xvfb-run -a "$WINE" reg query 'HKCU\Software\Classes\Directory\shell\TGGAGS-IDE\command' 2>/dev/null | grep -q "TGGAGS IDE.exe" && ok "Explorer context-menu entry" || bad "context-menu entry missing"

echo "update (/UPDATE: progress only, keeps the install folder and the extras the user chose)"
find "$WINEPREFIX/drive_c/users" -name "TGGAGS IDE.lnk" -path "*Desktop*" -delete  # this user did not want the desktop shortcut
timeout 300 xvfb-run -a "$WINE" "$INSTALLER" /UPDATE >/dev/null 2>&1 || bad "the /UPDATE run failed or hung (it must close by itself)"
"${WINE%/*}/wineserver" -k >/dev/null 2>&1 || true   # the restarted app is not needed here
[ -f "$APP/TGGAGS IDE.exe" ] && [ -f "$APP/resources/app.asar" ] && ok "app files are back after the update" || bad "app files missing after the update"
find "$WINEPREFIX/drive_c/users" -name "TGGAGS IDE.lnk" | grep -q Start && ok "Start menu shortcut kept" || bad "Start menu shortcut missing after update"
find "$WINEPREFIX/drive_c/users" -name "TGGAGS IDE.lnk" | grep -q Desktop && bad "desktop shortcut came back although it was declined" || ok "declined desktop shortcut stays away"
xvfb-run -a "$WINE" reg query 'HKCU\Software\Classes\Directory\shell\TGGAGS-IDE\command' 2>/dev/null | grep -q "TGGAGS IDE.exe" && ok "context-menu entry kept" || bad "context-menu entry lost in the update"
xvfb-run -a "$WINE" reg query "$KEY" 2>/dev/null | grep -q "DisplayVersion" && ok "uninstall entry still registered" || bad "uninstall entry lost in the update"

echo "uninstall"
mkdir -p "$WINEPREFIX/drive_c/users/$USER/AppData/Roaming/TGGAGS IDE" && echo keep > "$WINEPREFIX/drive_c/users/$USER/AppData/Roaming/TGGAGS IDE/settings.json"
xvfb-run -a "$WINE" "$APP/Uninstall.exe" /S "_?=C:\\users\\$USER\\AppData\\Local\\Programs\\TGGAGS IDE" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do [ ! -e "$APP" ] && break; sleep 1; done  # the uninstaller finishes in a helper process
[ ! -e "$APP" ] && ok "program files removed" || bad "program files left behind"
xvfb-run -a "$WINE" reg query "$KEY" >/dev/null 2>&1 && bad "uninstall entry left behind" || ok "registry cleaned"
[ -z "$(find "$WINEPREFIX/drive_c/users" -name '*.lnk' | grep 'TGGAGS' || true)" ] && ok "shortcuts removed" || bad "shortcuts left behind"
[ -f "$WINEPREFIX/drive_c/users/$USER/AppData/Roaming/TGGAGS IDE/settings.json" ] && ok "user data kept in silent mode" || bad "user data was deleted"
echo; echo "INSTALLER TEST PASSED"
