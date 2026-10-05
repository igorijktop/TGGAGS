; TGGAGS IDE – offline Windows installer (NSIS 3, Modern UI 2).
; Built by scripts/package-win.mjs, which passes: VERSION PRODUCT EXE SRC OUT RES
Unicode True
ManifestDPIAware true

!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!ifndef PRODUCT
  !define PRODUCT "TGGAGS IDE"
!endif
!define APP_ID "TGGAGS-IDE"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"

Name "${PRODUCT}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"
InstallDirRegKey HKCU "Software\${APP_ID}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 128
BrandingText "${PRODUCT} ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow
CRCCheck on

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "TGGAGS"

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define MUI_ICON "${RES}\icon.ico"
!define MUI_UNICON "${RES}\icon.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${RES}\installer-sidebar.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${RES}\installer-sidebar.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${RES}\installer-header.bmp"
!define MUI_HEADERIMAGE_RIGHT
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_RUN_TEXT "$(STR_LAUNCH)"
!define MUI_COMPONENTSPAGE_SMALLDESC

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"

LangString STR_LAUNCH ${LANG_ENGLISH} "Launch ${PRODUCT}"
LangString STR_LAUNCH ${LANG_RUSSIAN} "Запустить ${PRODUCT}"
LangString SEC_MAIN ${LANG_ENGLISH} "${PRODUCT} (required)"
LangString SEC_MAIN ${LANG_RUSSIAN} "${PRODUCT} (обязательно)"
LangString SEC_DESKTOP ${LANG_ENGLISH} "Desktop shortcut"
LangString SEC_DESKTOP ${LANG_RUSSIAN} "Ярлык на рабочем столе"
LangString SEC_CONTEXT ${LANG_ENGLISH} "“Open with ${PRODUCT}” in the Explorer context menu"
LangString SEC_CONTEXT ${LANG_RUSSIAN} "«Открыть в ${PRODUCT}» в контекстном меню проводника"
LangString DESC_MAIN ${LANG_ENGLISH} "The editor, the AI agents and everything they need. No internet connection is required."
LangString DESC_MAIN ${LANG_RUSSIAN} "Редактор, ИИ-агенты и всё необходимое. Подключение к интернету не требуется."
LangString DESC_DESKTOP ${LANG_ENGLISH} "Adds a shortcut to your desktop."
LangString DESC_DESKTOP ${LANG_RUSSIAN} "Добавляет ярлык на рабочий стол."
LangString DESC_CONTEXT ${LANG_ENGLISH} "Right-click a folder or file in Explorer to open it here."
LangString DESC_CONTEXT ${LANG_RUSSIAN} "Правый клик по папке или файлу в проводнике — открыть здесь."
LangString STR_UPGRADE ${LANG_ENGLISH} "Removing the previous version…"
LangString STR_UPGRADE ${LANG_RUSSIAN} "Удаление предыдущей версии…"
LangString STR_KEEPDATA ${LANG_ENGLISH} "Also delete your settings, chats and saved images?$\r$\n$\r$\nChoose No to keep them for a future installation."
LangString STR_KEEPDATA ${LANG_RUSSIAN} "Удалить также ваши настройки, чаты и сохранённые изображения?$\r$\n$\r$\nВыберите «Нет», чтобы сохранить их для будущей установки."
LangString STR_RUNNING ${LANG_ENGLISH} "${PRODUCT} is running. Please close it, then click Retry."
LangString STR_RUNNING ${LANG_RUSSIAN} "${PRODUCT} сейчас запущен. Закройте его и нажмите «Повтор»."

Function LaunchApp
  ; start un-elevated through Explorer-less ShellExecute so the app inherits the user's normal environment
  Exec '"$INSTDIR\${EXE}"'
FunctionEnd

; ───────── upgrade in place: silently remove a previous version first ─────────
Function .onInit
  ReadRegStr $R0 HKCU "${UNINST_KEY}" "UninstallString"
  ReadRegStr $R1 HKCU "${UNINST_KEY}" "InstallLocation"
  ${If} $R0 != ""
  ${AndIf} $R1 != ""
    IfFileExists "$R1\Uninstall.exe" 0 done
    ExecWait '"$R1\Uninstall.exe" /S _?=$R1'
    Delete "$R1\Uninstall.exe"
    RMDir "$R1"
  ${EndIf}
  done:
FunctionEnd

Section "$(SEC_MAIN)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on
  retry:
  ClearErrors
  File /r "${SRC}\*.*"
  IfErrors 0 +3
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(STR_RUNNING)" IDRETRY retry
    Abort

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\${APP_ID}" "InstallDir" "$INSTDIR"

  CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "TGGAGS"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "$(SEC_DESKTOP)" SecDesktop
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
SectionEnd

Section "$(SEC_CONTEXT)" SecContext
  WriteRegStr HKCU "Software\Classes\Directory\shell\${APP_ID}" "" "Open with ${PRODUCT}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${APP_ID}" "Icon" '"$INSTDIR\${EXE}"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\${APP_ID}\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${APP_ID}" "" "Open with ${PRODUCT}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${APP_ID}" "Icon" '"$INSTDIR\${EXE}"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${APP_ID}\command" "" '"$INSTDIR\${EXE}" "%V"'
  WriteRegStr HKCU "Software\Classes\*\shell\${APP_ID}" "" "Open with ${PRODUCT}"
  WriteRegStr HKCU "Software\Classes\*\shell\${APP_ID}" "Icon" '"$INSTDIR\${EXE}"'
  WriteRegStr HKCU "Software\Classes\*\shell\${APP_ID}\command" "" '"$INSTDIR\${EXE}" "%1"'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "$(DESC_MAIN)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "$(DESC_DESKTOP)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecContext} "$(DESC_CONTEXT)"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ───────── uninstaller ─────────
Section "Uninstall"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\${APP_ID}"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\${APP_ID}"
  DeleteRegKey HKCU "Software\Classes\*\shell\${APP_ID}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_ID}"

  ; the app folder (the uninstaller itself is removed last by NSIS)
  RMDir /r "$INSTDIR"

  ; user data is only removed when asked for (never in silent mode, so upgrades keep everything)
  IfSilent skipdata
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(STR_KEEPDATA)" IDNO skipdata
  RMDir /r "$APPDATA\${PRODUCT}"
  skipdata:
SectionEnd
