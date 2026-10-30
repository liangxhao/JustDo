!ifndef INSTALLER_PRESENTATION_WINDOW_INCLUDED
!define INSTALLER_PRESENTATION_WINDOW_INCLUDED

Var InstallerWindowReady
Var InstallerWindowPage

; A separator belongs to the current child page, so nsDialogs cannot raise a
; newly shown page over it. The page's native destruction owns its lifetime.
!macro InstallerWindowDivider _PAGE
  Push $0
  GetDlgItem $0 ${_PAGE} 12351
  ${If} $0 == 0
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x54000000, i 0, i 0, i $InstallerWidth, i 1, p ${_PAGE}, p 12351, p 0, p 0)p.r0'
    SetCtlColors $0 "E5E7ED" "E5E7ED"
  ${EndIf}
  Pop $0
!macroend

; One geometry authority for mode, directory, writing and result pages. Center
; only the first page. Later transitions read the real HWND rectangle, retaining
; a user's drag even if it happened after the preceding page's SHOW callback.
Function InstallerWindowPrepare
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R9
  StrCpy $R9 "0"
  ${If} ${Errors}
    StrCpy $R9 "1"
  ${EndIf}
  StrCpy $R5 "0"
  Call InstallerPresentationChrome
  StrCpy $9 $HWNDPARENT
  StrCpy $R4 "0"
  ${If} $InstallerWindowReady == "1"
    StrCpy $R4 "1"
  ${Else}
    ; UAC creates a different installer HWND. Read the outer window through
    ; its existing helper; no command line, profile or installation state changes.
    !ifmacrodef UAC_AsUser_GetGlobal
      ${If} ${UAC_IsInnerInstance}
        !insertmacro UAC_AsUser_GetGlobal $0 $HWNDPARENT
        System::Call 'user32::IsWindow(p r0)i.r1'
        ${If} $1 != 0
          StrCpy $9 $0
          StrCpy $R4 "1"
        ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
  ; The UAC outer window may have been dragged to a different-DPI monitor.
  ; Derive the layout from that anchor before positioning the inner window.
  System::Call 'user32::GetDpiForWindow(p r9)i.r0'
  ${If} $0 < 96
    StrCpy $0 96
  ${EndIf}
  StrCpy $InstallerDpi $0
  !ifmacrodef InstallerWindowDpi
    !insertmacro InstallerWindowDpi
  !endif
  System::Call 'user32::MonitorFromWindow(p r9, i 2)p.r0'
  System::Call '*(i 40, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0)p.s'
  Pop $R5
  ${If} $R5 == 0
    Goto InstallerWindowPrepared
  ${EndIf}
  System::Call 'user32::GetMonitorInfoW(p r0, p $R5)i.r1'
  ${If} $1 == 0
    Goto InstallerWindowPrepared
  ${EndIf}
  System::Call '*$R5(i, i, i, i, i, i .r2, i .r3, i .r4, i .r5)'
  StrCpy $InstallerWorkLeft $2
  StrCpy $InstallerWorkTop $3
  IntOp $InstallerWorkWidth $4 - $2
  IntOp $InstallerWorkHeight $5 - $3
  !ifmacrodef InstallerWindowWorkArea
    !insertmacro InstallerWindowWorkArea
  !endif
  !ifmacrodef InstallerPresentationWorkArea
    !insertmacro InstallerPresentationWorkArea
  !endif

  System::Call 'user32::GetWindowRect(p r9, p $R5)i.r0'
  ${If} $0 == 0
    Goto InstallerWindowPrepared
  ${EndIf}
  System::Call '*$R5(i .r0, i .r1)'
  StrCpy $R2 $0
  StrCpy $R3 $1
  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p $R5)i.r0'
  ${If} $0 == 0
    Goto InstallerWindowPrepared
  ${EndIf}
  System::Call '*$R5(i .r0, i .r1, i .r2, i .r3)'
  IntOp $R0 $2 - $0
  IntOp $R1 $3 - $1
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p $R5)i.r0'
  ${If} $0 == 0
    Goto InstallerWindowPrepared
  ${EndIf}
  System::Call '*$R5(i, i, i .r2, i .r3)'
  IntOp $R0 $R0 - $2
  IntOp $R1 $R1 - $3
  IntOp $InstallerWidth 680 * $InstallerDpi
  IntOp $InstallerWidth $InstallerWidth / 96
  IntOp $InstallerHeight 540 * $InstallerDpi
  IntOp $InstallerHeight $InstallerHeight / 96
  IntOp $6 32 * $InstallerDpi
  IntOp $6 $6 / 96
  IntOp $7 $InstallerWorkWidth - $6
  IntOp $7 $7 - $R0
  ${If} $InstallerWidth > $7
    StrCpy $InstallerWidth $7
  ${EndIf}
  IntOp $7 $InstallerWorkHeight - $6
  IntOp $7 $7 - $R1
  ${If} $InstallerHeight > $7
    StrCpy $InstallerHeight $7
  ${EndIf}
  IntOp $7 $InstallerWidth + $R0
  IntOp $8 $InstallerHeight + $R1
  StrCpy $0 $R2
  StrCpy $1 $R3
  ${If} $R4 != "1"
    IntOp $0 $InstallerWorkWidth - $7
    IntOp $0 $0 / 2
    IntOp $0 $0 + $InstallerWorkLeft
    IntOp $1 $InstallerWorkHeight - $8
    IntOp $1 $1 / 2
    IntOp $1 $1 + $InstallerWorkTop
  ${Else}
    ; Only a move to a smaller work area may need correction; never re-center.
    IntOp $2 $InstallerWorkLeft + $InstallerWorkWidth
    IntOp $2 $2 - $7
    ${If} $0 > $2
      StrCpy $0 $2
    ${EndIf}
    ${If} $0 < $InstallerWorkLeft
      StrCpy $0 $InstallerWorkLeft
    ${EndIf}
    IntOp $2 $InstallerWorkTop + $InstallerWorkHeight
    IntOp $2 $2 - $8
    ${If} $1 > $2
      StrCpy $1 $2
    ${EndIf}
    ${If} $1 < $InstallerWorkTop
      StrCpy $1 $InstallerWorkTop
    ${EndIf}
  ${EndIf}
  StrCpy $6 0x0014
  ${If} $9 == $HWNDPARENT
  ${AndIf} $0 == $R2
  ${AndIf} $1 == $R3
    ; SWP_NOMOVE also prevents a spurious position notification on Back/Next.
    StrCpy $6 0x0016
  ${EndIf}
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r1, i r7, i r8, i r6)i.r0'
  ${If} $0 != 0
    StrCpy $InstallerWindowReady "1"
  ${EndIf}
  InstallerWindowPrepared:
  ${If} $R5 != "0"
    System::Free $R5
  ${EndIf}
  ${If} $R9 == "1"
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $R9
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!endif
