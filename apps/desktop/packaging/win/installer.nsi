; Per-user installer for Linger on Windows. package.py passes VERSION,
; NUMERIC_VERSION (VERSION without a prerelease suffix, for the X.X.X.X field),
; STAGE (the app folder) and OUTPUT. No administrator rights are needed. The folder
; is fixed: the uninstaller removes all of it.
Unicode true
!include "MUI2.nsh"

Name "Linger"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Simplex"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Linger"

VIProductVersion "${NUMERIC_VERSION}.0"
VIAddVersionKey "ProductName" "Linger"
VIAddVersionKey "FileDescription" "Linger Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Linger"
VIAddVersionKey "LegalCopyright" "Linger"

!define MUI_ICON "${STAGE}\resources\linger.ico"
!define MUI_UNICON "${STAGE}\resources\linger.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Linger.exe"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; A running Linger holds its files open.
!macro CLOSE_LINGER UN
Function ${UN}CloseLinger
  retry:
  ClearErrors
  IfFileExists "$INSTDIR\Linger.exe" 0 done
  Delete "$INSTDIR\Linger.exe"
  IfErrors 0 done
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Linger is running. Quit it from its icon in the notification area, then select Retry." IDRETRY retry
  Abort
  done:
FunctionEnd
!macroend
!insertmacro CLOSE_LINGER ""
!insertmacro CLOSE_LINGER "un."

Section "Linger"
  SetOutPath "$INSTDIR"
  Call CloseLinger
  ; An update replaces the whole app folder.
  RMDir /r "$INSTDIR\resources"
  File /r "${STAGE}\*"
  WriteUninstaller "$INSTDIR\Uninstall Linger.exe"
  ; The app writes its notification id into this shortcut (index.ts).
  CreateShortcut "$SMPROGRAMS\Linger.lnk" "$INSTDIR\Linger.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Linger"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Linger"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Linger.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall Linger.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; Settings, sign-in and logs stay in %APPDATA%\Linger.
  Call un.CloseLinger
  Delete "$SMPROGRAMS\Linger.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; "Open at login", named after the app id (index.ts).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ai.simplex.desktop.preview"
SectionEnd
