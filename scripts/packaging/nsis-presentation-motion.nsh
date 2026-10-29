!ifndef INSTALLER_PRESENTATION_MOTION_INCLUDED
!define INSTALLER_PRESENTATION_MOTION_INCLUDED

!define INSTALLER_MOTION_OPEN "open"
!define INSTALLER_MOTION_CLOSE "close"
!define INSTALLER_MOTION_OPEN_MS 320
!define INSTALLER_MOTION_CLOSE_MS 200
!define INSTALLER_MOTION_LAYERED 0x00080000
!define INSTALLER_MOTION_ALPHA 2
!define INSTALLER_MOTION_POSITION_FLAGS 0x0015

Var InstallerMotionOpened
Var InstallerMotionClosed
Var InstallerMotionKind
Var InstallerMotionRect
Var InstallerMotionLeft
Var InstallerMotionTop
Var InstallerMotionDistance
Var InstallerMotionDuration
Var InstallerMotionStarted
Var InstallerMotionFrame
Var InstallerMotionAddedLayer

Function InstallerPresentationOpenMotion
  Push "${INSTALLER_MOTION_OPEN}"
  Call InstallerRunWindowMotion
FunctionEnd

Function InstallerPresentationCloseMotion
  Push "${INSTALLER_MOTION_CLOSE}"
  Call InstallerRunWindowMotion
FunctionEnd

; These short, bounded transitions run only in existing UI-owner callbacks.
; No message pump, script timer, resize or percentage interpolation is used.
; Raw alpha/position calls do not consult Windows' animation preference.
Function InstallerRunWindowMotion
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R9
  StrCpy $R9 "0"
  ${If} ${Errors}
    StrCpy $R9 "1"
  ${EndIf}
  StrCpy $InstallerMotionKind $0
  StrCpy $InstallerMotionRect "0"
  StrCpy $InstallerMotionAddedLayer "0"
  ${If} ${Silent}
    Goto InstallerMotionCleanup
  ${EndIf}
  ${If} $InstallerPresentationReady != "1"
    Goto InstallerMotionCleanup
  ${EndIf}
  ${If} $InstallerMotionKind == "${INSTALLER_MOTION_OPEN}"
    ${If} $InstallerMotionOpened == "1"
      Goto InstallerMotionCleanup
    ${EndIf}
  ${Else}
    ${If} $InstallerMotionClosed == "1"
    ${OrIf} $JustDoExtractorActive == "1"
      Goto InstallerMotionCleanup
    ${EndIf}
  ${EndIf}
  System::Call 'user32::IsWindow(p $HWNDPARENT)i.r0'
  ${If} $0 == 0
    Goto InstallerMotionCleanup
  ${EndIf}
  System::Call 'user32::GetWindowThreadProcessId(p $HWNDPARENT, p 0)i.r0'
  System::Call 'kernel32::GetCurrentThreadId()i.r1'
  ${If} $0 != $1
    Goto InstallerMotionCleanup
  ${EndIf}
  System::Call 'user32::IsIconic(p $HWNDPARENT)i.r0'
  ${If} $0 != 0
    Goto InstallerMotionCleanup
  ${EndIf}
  ${If} $InstallerMotionKind == "${INSTALLER_MOTION_CLOSE}"
    System::Call 'user32::IsWindowVisible(p $HWNDPARENT)i.r0'
    ${If} $0 == 0
      Goto InstallerMotionCleanup
    ${EndIf}
  ${EndIf}
  ; Do not overwrite a layer/opacity owned by another presentation mechanism.
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'
  IntOp $1 $0 & ${INSTALLER_MOTION_LAYERED}
  ${If} $1 != 0
    Goto InstallerMotionCleanup
  ${EndIf}
  System::Alloc 16
  Pop $InstallerMotionRect
  ${If} $InstallerMotionRect == 0
    Goto InstallerMotionCleanup
  ${EndIf}
  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p $InstallerMotionRect)i.r1'
  ${If} $1 == 0
    Goto InstallerMotionCleanup
  ${EndIf}
  System::Call '*$InstallerMotionRect(i .r1, i .r2)'
  StrCpy $InstallerMotionLeft $1
  StrCpy $InstallerMotionTop $2
  ${If} $InstallerMotionKind == "${INSTALLER_MOTION_OPEN}"
    StrCpy $InstallerMotionDuration ${INSTALLER_MOTION_OPEN_MS}
    IntOp $InstallerMotionDistance $InstallerDpi * 8
  ${Else}
    StrCpy $InstallerMotionClosed "1"
    StrCpy $InstallerMotionDuration ${INSTALLER_MOTION_CLOSE_MS}
    IntOp $InstallerMotionDistance $InstallerDpi * 4
  ${EndIf}
  IntOp $InstallerMotionDistance $InstallerMotionDistance / 96
  IntOp $0 $0 | ${INSTALLER_MOTION_LAYERED}
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)i.r1'
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'
  IntOp $0 $0 & ${INSTALLER_MOTION_LAYERED}
  ${If} $0 == 0
    Goto InstallerMotionCleanup
  ${EndIf}
  StrCpy $InstallerMotionAddedLayer "1"
  ${If} $InstallerMotionKind == "${INSTALLER_MOTION_OPEN}"
    System::Call 'user32::SetLayeredWindowAttributes(p $HWNDPARENT, i 0, i 0, i ${INSTALLER_MOTION_ALPHA})i.r0'
    ${If} $0 == 0
      Goto InstallerMotionCleanup
    ${EndIf}
    ; NSIS SHOW precedes its own ShowWindow(page). Render the actual page now,
    ; while the parent is transparent, rather than fading an empty first frame.
    ShowWindow $JustDoInstFilesPage 8
    SendMessage $HWNDPARENT ${JUSTDO_WM_SETREDRAW} 1 0
    ShowWindow $HWNDPARENT 4
    System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i ${JUSTDO_RDW_ATOMIC_REFRESH})i.r0'
  ${EndIf}
  StrCpy $InstallerMotionFrame "0"
  System::Call 'kernel32::GetTickCount()i.r0'
  StrCpy $InstallerMotionStarted $0

  InstallerMotionNextFrame:
  System::Call 'kernel32::GetTickCount()i.r0'
  IntOp $1 $0 - $InstallerMotionStarted
  ${If} $1 < 0
  ${OrIf} $1 >= $InstallerMotionDuration
  ${OrIf} $InstallerMotionFrame >= 64
    StrCpy $1 1000
  ${Else}
    IntOp $1 $1 * 1000
    IntOp $1 $1 / $InstallerMotionDuration
  ${EndIf}
  StrCpy $9 $1
  ${If} $InstallerMotionKind == "${INSTALLER_MOTION_OPEN}"
    IntOp $1 1000 - $1
  ${EndIf}
  ; Fixed-point cubic easing keeps intermediate products within signed 32-bit.
  IntOp $2 $1 * $1
  IntOp $2 $2 / 1000
  IntOp $2 $2 * $1
  IntOp $2 $2 / 1000
  ${If} $InstallerMotionKind == "${INSTALLER_MOTION_OPEN}"
    IntOp $3 1000 - $2
    IntOp $3 $3 * 219
    IntOp $3 $3 / 1000
    IntOp $3 $3 + 36
  ${Else}
    IntOp $3 1000 - $2
    IntOp $3 $3 * 255
    IntOp $3 $3 / 1000
  ${EndIf}
  IntOp $4 $InstallerMotionDistance * $2
  IntOp $4 $4 / 1000
  IntOp $4 $4 + $InstallerMotionTop
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i $InstallerMotionLeft, i r4, i 0, i 0, i ${INSTALLER_MOTION_POSITION_FLAGS})i.r0'
  ${If} $0 == 0
    Goto InstallerMotionCleanup
  ${EndIf}
  System::Call 'user32::SetLayeredWindowAttributes(p $HWNDPARENT, i 0, i r3, i ${INSTALLER_MOTION_ALPHA})i.r0'
  ${If} $0 == 0
    Goto InstallerMotionCleanup
  ${EndIf}
  !ifmacrodef InstallerMotionTraceFrame
    !insertmacro InstallerMotionTraceFrame
  !endif
  ${If} $9 == 1000
    Goto InstallerMotionCleanup
  ${EndIf}
  IntOp $InstallerMotionFrame $InstallerMotionFrame + 1
  Sleep 15
  Goto InstallerMotionNextFrame

  InstallerMotionCleanup:
  ${If} $InstallerMotionAddedLayer == "1"
    ${If} $InstallerMotionKind == "${INSTALLER_MOTION_CLOSE}"
      ; Hide before restoring opacity/style, so EndDialog cannot flash a frame.
      ShowWindow $HWNDPARENT 0
    ${Else}
      StrCpy $InstallerMotionOpened "1"
    ${EndIf}
    System::Call 'user32::SetLayeredWindowAttributes(p $HWNDPARENT, i 0, i 255, i ${INSTALLER_MOTION_ALPHA})i.r0'
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i $InstallerMotionLeft, i $InstallerMotionTop, i 0, i 0, i ${INSTALLER_MOTION_POSITION_FLAGS})i.r0'
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r0'
    IntOp $0 $0 & 0xFFF7FFFF
    System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)i.r1'
    ${If} $InstallerMotionKind == "${INSTALLER_MOTION_OPEN}"
      SendMessage $HWNDPARENT ${JUSTDO_WM_SETREDRAW} 1 0
      System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i ${JUSTDO_RDW_ATOMIC_REFRESH})i.r0'
    ${EndIf}
    !ifmacrodef InstallerMotionTraceComplete
      !insertmacro InstallerMotionTraceComplete
    !endif
  ${EndIf}
  ${If} $InstallerMotionRect != "0"
    System::Free $InstallerMotionRect
    StrCpy $InstallerMotionRect "0"
  ${EndIf}
  ${If} $R9 == "1"
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $R9
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
