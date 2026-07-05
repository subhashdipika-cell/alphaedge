; ============================================================
;  AlphaEdge AI Trading Platform - OFFLINE (self-contained) installer
;  Bundles app + Node.js runtime + all node_modules.
;  Installs with NO internet connection required.
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
OutFile "..\installer_output\AlphaEdge_Setup_Offline_SelfContained.exe"
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
!define MUI_FINISHPAGE_RUN_TEXT "Run first-time setup now (offline - installs bundled runtime)"
!define MUI_FINISHPAGE_RUN_FUNCTION RunFirstTimeSetup
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function RunFirstTimeSetup
  ExecShell "open" "$INSTDIR\setup_offline.bat"
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

  ; Bundled Node.js runtime (zip, extracted by setup_offline.bat)
  SetOutPath "$INSTDIR\runtime_src"
  File "/oname=node-embed.zip" "..\build_assets\node-win-x64.zip"

  ; Bundled node_modules (snapshot of npm install output)
  SetOutPath "$INSTDIR\node_modules_bundled"
  File /r "..\build_assets\node_modules_snapshot\*"

  ; Setup + launch scripts (from installer\ folder)
  SetOutPath "$INSTDIR"
  File "setup_offline.bat"
  File "start_alphaedge.bat"
  File "stop_alphaedge.bat"

  ; Start Menu shortcuts
  CreateDirectory "$SMPROGRAMS\${AppName}"
  CreateShortCut "$SMPROGRAMS\${AppName}\Start AlphaEdge.lnk"        "$INSTDIR\start_alphaedge.bat"
  CreateShortCut "$SMPROGRAMS\${AppName}\Stop AlphaEdge.lnk"         "$INSTDIR\stop_alphaedge.bat"
  CreateShortCut "$SMPROGRAMS\${AppName}\First Time Setup.lnk"       "$INSTDIR\setup_offline.bat"
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
