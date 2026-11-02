; Hooks for Tauri's NSIS installer template (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; Update in place. Run over an older installed version, the setup wizard would offer to uninstall it first (and preselect
; that). Instead the installer asks once, then starts itself again the way the app's own updater runs it
; (/P /UPDATE /R): a progress window only, no uninstall, the same install folder and Start menu entry, and the app
; started again at the end. Settings, sessions and saved data live outside the install folder and are kept. The same or
; a newer installed version, the updater (/UPDATE), passive (/P) and silent (/S) runs keep the template's behaviour.
;
; Graceful stop. Before files are replaced or removed, a running app is asked to quit as for an in-app update
; (sessions paused and saved, OMP stopped, the bundled Bun ended, and the working ones noted so the next launch resumes
; them) through the named event it waits on
; (quit_on_installer_request in src-tauri/src/main.rs). Only an app still running after OMP_QUIT_WAIT, or one too old to
; be asked, is closed by the template's check (asks first, except in passive and silent runs). The companion's Bun
; saves sessions when the app goes away, so it gets OMP_BUN_WAIT to end on its own before that check closes it too.
;
; Clean replace. node_modules/, companion/, local-dist/ and desktop/ never mix two versions, so files an older version
; shipped and this one doesn't (a package npm hoisted differently, say) can't shadow the new ones. The installer moves
; them into .previous\ (a rename, instant) before the new files go in and deletes that folder in the background once
; it's done. The uninstaller deletes them and any .previous\ outright, older versions' leftovers included.
;
; node_modules/ only when it changed. Its ~12,000 files (OMP's SDK and what it needs) are most of an install's time,
; and most releases don't change them. They are not a Tauri resource: this file packs src-tauri/runtime/ (staged by
; scripts/stage-runtime.mjs) itself, after the template's files, and marks the installed copy with the stage's id
; (src-tauri/runtime.stamp) in node_modules\.runtime-id. An install whose node_modules\ carries this build's id keeps
; it as it is; the solid archive is then never decompressed that far, so those updates take seconds.

; In tenths of a second. The app's Quit waits up to 120 s for the companion to save sessions, then 10 s for Bun to exit.
!define OMP_QUIT_WAIT 1500
!define OMP_BUN_WAIT 300

; src-tauri\, without a "..": makensis can't open paths over 259 characters and the deepest packages need most of that.
!searchreplace OMP_SRC_TAURI "${__FILEDIR__}|" "\windows|" ""
!define /file OMP_RUNTIME_ID "${OMP_SRC_TAURI}\runtime.stamp"

; Sets `out` to 1 when $INSTDIR\node_modules is this build's, else to "".
!macro OMP_RUNTIME_CURRENT out
  StrCpy ${out} ""
  ClearErrors
  FileOpen $R6 "$INSTDIR\node_modules\.runtime-id" r
  ${IfNot} ${Errors}
    FileRead $R6 $R7
    FileClose $R6
    ${If} $R7 == "${OMP_RUNTIME_ID}"
      StrCpy ${out} 1
    ${EndIf}
  ${EndIf}
!macroend

; Runs before the first page (MUI calls it from .onGUIInit; never in silent runs). This file is included above the
; template's defines and variables, so it reads the installed version from the registry, this installer's version from
; its own version resource and the product name from $(^Name).
!define MUI_CUSTOMFUNCTION_GUIINIT OmpUpdateInPlace
Function OmpUpdateInPlace
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$(^Name)" "DisplayVersion"
  ${If} $0 == ""
    Return
  ${EndIf}
  ; VIProductVersion: this version plus a fourth ".0" part.
  ${GetFileVersion} "$EXEPATH" $1
  ${VersionCompare} $1 $0 $2
  ${If} $2 <> 1
    Return
  ${EndIf}
  ${WordFind} $1 "." "-1{" $1
  MessageBox MB_OKCANCEL|MB_ICONQUESTION "Update $(^Name) $0 to $1?$\n$\nIt is updated where it is installed, without uninstalling it first. Your settings, sessions and saved data are kept.$\n$\nIf $(^Name) is running, it closes first and starts again when the update is done; sessions that were working pause for the update and carry on by themselves." IDOK omp_update
  Quit
  omp_update:
  Exec '"$EXEPATH" /P /UPDATE /R'
  Quit
FunctionEnd

; Waits until no process runs the file at `path`, for at most `tenths` tenths of a second.
!macro OMP_WAIT_FOR_EXIT path tenths
  StrCpy $R9 0
  ${Do}
    !insertmacro RestartManager_StartSession $R8
    ${If} $R8 == ""
      ${ExitDo}
    ${EndIf}
    !insertmacro RestartManager_RegisterFile $R8 "${path}"
    ; ERROR_MORE_DATA: some process runs it.
    System::Call 'RSTRTMGR::RmGetList(p R8, *i .r1, *i .r2, p 0, *i .r3) i .r0'
    !insertmacro RestartManager_EndSession $R8
    ${If} $0 <> ${ERROR_MORE_DATA}
    ${OrIf} $R9 >= ${tenths}
      ${ExitDo}
    ${EndIf}
    Sleep 100
    IntOp $R9 $R9 + 1
  ${Loop}
!macroend

!macro OMP_STOP_APP
  ; EVENT_MODIFY_STATE. The name must match quit_on_installer_request in src-tauri/src/main.rs.
  System::Call 'kernel32::OpenEventW(i 0x0002, i 0, w "Local\${BUNDLEID}.quit-for-update") p.r1'
  ${If} $1 <> 0
    DetailPrint "Closing ${PRODUCTNAME}: pausing and saving sessions..."
    System::Call 'kernel32::SetEvent(p r1)'
    System::Call 'kernel32::CloseHandle(p r1)'
    !insertmacro OMP_WAIT_FOR_EXIT "$INSTDIR\${MAINBINARYNAME}.exe" ${OMP_QUIT_WAIT}
  ${EndIf}
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro OMP_WAIT_FOR_EXIT "$INSTDIR\bun.exe" ${OMP_BUN_WAIT}
  !insertmacro CheckIfAppIsRunning "$INSTDIR\bun.exe" "${PRODUCTNAME}"
!macroend

; Moves $INSTDIR\<dir> into $INSTDIR\.previous\ for NSIS_HOOK_POSTINSTALL to delete in the background.
!macro OMP_SET_ASIDE dir
  ${If} ${FileExists} "$INSTDIR\${dir}\*.*"
    Rename "$INSTDIR\${dir}" "$INSTDIR\.previous\${dir}"
    ; Not moved (a file still open, say): delete it here instead.
    ${If} ${FileExists} "$INSTDIR\${dir}\*.*"
      RMDir /r "$INSTDIR\${dir}"
    ${EndIf}
  ${EndIf}
!macroend

!macro OMP_REMOVE_RESOURCES
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\companion"
  RMDir /r "$INSTDIR\local-dist"
  RMDir /r "$INSTDIR\desktop"
  RMDir /r "$INSTDIR\.previous"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro OMP_STOP_APP
  ; Only in a folder holding this app: a fresh install into a folder of the user's own must not touch its contents.
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ; What an earlier update's background delete didn't finish.
    RMDir /r "$INSTDIR\.previous"
    CreateDirectory "$INSTDIR\.previous"
    !insertmacro OMP_RUNTIME_CURRENT $R5
    ${If} $R5 != 1
      !insertmacro OMP_SET_ASIDE "node_modules"
    ${EndIf}
    !insertmacro OMP_SET_ASIDE "companion"
    !insertmacro OMP_SET_ASIDE "local-dist"
    !insertmacro OMP_SET_ASIDE "desktop"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro OMP_RUNTIME_CURRENT $R5
  ${If} $R5 == 1
    DetailPrint "node_modules is unchanged since the installed version; keeping it."
  ${Else}
    SetOutPath "$INSTDIR\node_modules"
    File /r "${OMP_SRC_TAURI}\runtime\*"
    ; Written last: an install cut short leaves no id, and the next one writes node_modules again.
    FileOpen $R6 "$INSTDIR\node_modules\.runtime-id" w
    FileWrite $R6 "${OMP_RUNTIME_ID}"
    FileClose $R6
    SetOutPath "$INSTDIR"
    ; The template measured the folder before node_modules was there.
    ${GetSize} "$INSTDIR" "/S=0K /G=0" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\.previous\*.*"
    ExecShell "" "$SYSDIR\cmd.exe" '/d /c rd /s /q "$INSTDIR\.previous"' SW_HIDE
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro OMP_STOP_APP
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro OMP_REMOVE_RESOURCES
  ${EndIf}
!macroend
