# TGGAGS IDE — Windows installer

**`TGGAGS-IDE-Setup.exe`** (64-bit Windows 10/11, about 95 MiB) — double-click it and the setup wizard starts.
It is fully offline: no download happens while installing or running the editor.

* Installs for the current user (no administrator rights), to `%LOCALAPPDATA%\Programs\TGGAGS IDE`
* Wizard in English or Russian (follows the Windows language); optional desktop shortcut and *Open with TGGAGS IDE* in the Explorer menu
* Silent install: `TGGAGS-IDE-Setup.exe /S` · silent uninstall: `"%LOCALAPPDATA%\Programs\TGGAGS IDE\Uninstall.exe" /S`
* Not code-signed → SmartScreen may ask: *More info → Run anyway*

SHA-256: `ecdfc0b642eecb5b355d1c20bcf237119901c795b454eaa83b8a8ab09f1e36da`

Rebuild it yourself: `npm ci && npm run installer:win` (needs `makensis`), or run the **Build Windows installer** workflow on GitHub.
