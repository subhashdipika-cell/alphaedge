; ============================================================
;  AlphaEdge AI Trading Platform - ONLINE installer
;  Bundles the app only. Downloads Node.js + packages on first run.
;  Built by build_installers.bat (runs makensis from this installer\ folder).
;  All paths are relative to this installer\ directory.
; ============================================================

Unicode true
!include "MUI2.nsh"

!define AppName     "AlphaEdge"
!define AppVersion  "3.0"
!define AppPublisher "Subhash Chand Sharma"
!define AppDir      "AlphaEdge"
!define UninstKey   "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlphaEdge"

Name "${AppName} AI Trading Platform"
OutFile "..\installer_output\AlphaEdge_Setup_Online.exe"
InstallDir "$PROGRAMFILES64\${AppDir}"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

; !define MUI_ICON "alphaedge.ico"   ; add an .ico file here if you have one
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Run first-time setup now (downloads Node.js + packages)"
!define MUI_FINISHPAGE_RUN_FUNCTION RunFirstTimeSetup
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function RunFirstTimeSetup
  ExecShell "open" "$INSTDIR\setup_online.bat"
FunctionEnd

Section "AlphaEdge (required)" SecMain
  SectionIn RO
  SetShellVarContext all

  ; App source files
  SetOutPath "$INSTDIR\src"
  File /r "..\src\*"

  SetOutPath "$INSTDIR\public"
  File /r "..\public\*"

  SetOutPath "$INSTDIR"
  File "..\package.json"
  File "..\package-lock.json"
  File "..\index.html"
  File "..\vite.config.js"
  File "..\eslint.config.js"

  ; MT5 bridge
  SetOutPath "$INSTDIR\mt5-bridge"
  File /r "..\mt5-bridge\*"

  ; Setup + launch scripts (from installer\ folder)
  SetOutPath "$INSTDIR"
  File "setup_online.bat"
  File "start_alphaedge.bat"
  File "stop_alphaedge.bat"

  ; Start Menu shortcuts
  CreateDirectory "$SMPROGRAMS\${AppName}"
  CreateShortCut "$SMPROGRAMS\${AppName}\Start AlphaEdge.lnk"        "$INSTDIR\start_alphaedge.bat"
  CreateShortCut "$SMPROGRAMS\${AppName}\Stop AlphaEdge.lnk"         "$INSTDIR\stop_alphaedge.bat"
  CreateShortCut "$SMPROGRAMS\${AppName}\First Time Setup.lnk"       "$INSTDIR\setup_online.bat"
  CreateShortCut "$SMPROGRAMS\${AppName}\Uninstall ${AppName}.lnk"   "$INSTDIR\uninstall.exe"

  ; Uninstaller + Add/Remove Programs entry
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr   HKLM "${UninstKey}" "DisplayName"     "${AppName} AI Trading Platform"
  WriteRegStr   HKLM "${UninstKey}" "DisplayVersion"  "${AppVersion}"
  WriteRegStr   HKLM "${UninstKey}" "Publisher"       "${AppPublisher}"
  WriteRegStr   HKLM "${UninstKey}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD HKLM "${UninstKey}" "NoModify" 1
  WriteRegDWORD HKLM "${UninstKey}" "NoRepair" 1
SectionEnd

Section "Desktop shortcut" SecDesktop
  SetShellVarContext all
  CreateShortCut "$DESKTOP\AlphaEdge.lnk" "$INSTDIR\start_alphaedge.bat"
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\AlphaEdge.lnk"
  RMDir /r "$SMPROGRAMS\${AppName}"
  DeleteRegKey HKLM "${UninstKey}"
SectionEnd
