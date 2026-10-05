# TGGAGS IDE — Windows installer

**`TGGAGS-IDE-Setup.exe`** (64-bit Windows 10/11, about 95 MiB) — double-click it and the setup wizard starts.
It is fully offline: no download happens while installing or running the editor.

* Installs for the current user (no administrator rights), to `%LOCALAPPDATA%\Programs\TGGAGS IDE`
* Wizard in English or Russian (follows the Windows language); optional desktop shortcut and *Open with TGGAGS IDE* in the Explorer menu
* Silent install: `TGGAGS-IDE-Setup.exe /S` · silent uninstall: `"%LOCALAPPDATA%\Programs\TGGAGS IDE\Uninstall.exe" /S`
* Not code-signed → SmartScreen may ask: *More info → Run anyway*

SHA-256: `f1a2930cd0e7b231e56dd243fccf2df2ea17023a8c085abfaf14c5a8b1f8cf47`

Rebuild it yourself: `npm ci && npm run installer:win` (needs `makensis`), or run the **Build Windows installer** workflow on GitHub.
