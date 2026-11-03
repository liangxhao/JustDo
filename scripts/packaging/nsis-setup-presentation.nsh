!ifndef INSTALLER_SETUP_PRESENTATION_INCLUDED
!define INSTALLER_SETUP_PRESENTATION_INCLUDED

Var InstallerSetupReady
Var InstallerSetupPage
Var InstallerSetupDpi
Var InstallerSetupWidth
Var InstallerSetupHeight
Var InstallerSetupPageHeight
Var InstallerSetupCompact
Var InstallerSetupMinimal
Var InstallerSetupFont
Var InstallerSetupBodyFont
Var InstallerSetupTitleFont
Var InstallerSetupNavFont
Var InstallerSetupHeading
Var InstallerSetupSubheading
Var InstallerSetupLogo
Var InstallerSetupBitmap
Var InstallerSetupFieldLabel
Var InstallerSetupNextImage
Var InstallerSetupBackImage
Var InstallerSetupCancelImage
Var InstallerSetupBrowseImage
Var InstallerSetupBrowseControl

!include "nsDialogs.nsh"
!include "${PROJECT_DIR}\scripts\packaging\nsis-existing-installation.nsh"

Var InstallerCombinedPage
Var InstallerCombinedCurrentUser
Var InstallerCombinedAllUsers
Var InstallerCombinedDirectory
Var InstallerCombinedDirectorySurface
Var InstallerCombinedBrowse
Var InstallerCombinedHint
Var InstallerCombinedSpaceRequired
Var InstallerCombinedSpaceAvailable
Var InstallerCombinedScopeLabel
Var InstallerCombinedMode
Var InstallerCombinedUserDraft
Var InstallerCombinedMachineDraft
Var InstallerCombinedUserDraftSet
Var InstallerCombinedMachineDraftSet
Var InstallerCombinedLockedDirectory
Var InstallerCombinedPath
Var InstallerCombinedSelectionPath
Var InstallerCombinedSelectionReady
Var InstallerCombinedPathValid
Var InstallerCombinedUpdating
Var InstallerCombinedReady
Var InstallerCombinedEvent
Var InstallerCombinedForcedMode
Var InstallerCombinedLockedMode
Var InstallerCombinedElevationResult
Var InstallerCombinedHintIsError
Var InstallerCombinedHandoffReady
Var InstallerCombinedHandoffPath

; Reserve enough script-buffer space for a slash and the longest allowed
; product filename when the existing first-install normalizer appends it.
!define /math INSTALLER_COMBINED_PATH_LIMIT ${NSIS_MAX_STRLEN} - 66

!macro InstallerSetupSave
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
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  StrCpy $R9 "0"
  ${If} ${Errors}
    StrCpy $R9 "1"
  ${EndIf}
  ; The UAC register bridge may replace every general register. Keep the
  ; saved error bit on the unsynchronized stack, not in a live register.
  Push $R9
!macroend

!macro InstallerSetupRestore
  Pop $R9
  ${If} $R9 == "1"
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
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
!macroend

!macro InstallerSetupScale _OUTPUT _VALUE
  IntOp ${_OUTPUT} ${_VALUE} * $InstallerSetupDpi
  IntOp ${_OUTPUT} ${_OUTPUT} / 96
!macroend

!macro InstallerSetupMove _CONTROL _X _Y _WIDTH _HEIGHT
  System::Call 'user32::SetWindowPos(p ${_CONTROL}, p 0, i ${_X}, i ${_Y}, i ${_WIDTH}, i ${_HEIGHT}, i 0x0014)i.r9'
!macroend

!macro InstallerSetupFont _CONTROL
  SendMessage ${_CONTROL} ${INSTALLER_WM_SETFONT} $InstallerSetupBodyFont 0
  SetCtlColors ${_CONTROL} "475569" "${INSTALLER_BACKGROUND}"
!macroend

; Cards are passive decoration behind native fields and auto-radio controls.
; No group/tab style, command handler or selection state belongs to the card.
!macro InstallerSetupCard _CONTROL _ID _TOP _HEIGHT _COLOR
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
  !insertmacro InstallerSetupScale $0 24
  !insertmacro InstallerSetupScale $1 ${_TOP}
  IntOp $2 $0 * 2
  IntOp $2 $InstallerSetupWidth - $2
  !insertmacro InstallerSetupScale $3 ${_HEIGHT}
  GetDlgItem $4 $InstallerSetupPage ${_ID}
  ${If} $4 == 0
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x54000000, i r0, i r1, i r2, i r3, p $InstallerSetupPage, p ${_ID}, p 0, p 0)p.r4'
  ${EndIf}
  ${If} $4 != 0
    SetCtlColors $4 "${_COLOR}" "${_COLOR}"
    !insertmacro InstallerSetupScale $5 14
    IntOp $6 $2 + 1
    IntOp $7 $3 + 1
    System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i r6, i r7, i r5, i r5)p.r8'
    ${If} $8 != 0
      System::Call 'user32::SetWindowRgn(p r4, p r8, i 0)i.r9'
      ${If} $9 == 0
        System::Call 'gdi32::DeleteObject(p r8)i.r9'
      ${EndIf}
    ${EndIf}
    ; Keep the field's native HWND and its existing group order above this
    ; non-interactive surface. Windows owns a successfully assigned region.
    System::Call 'user32::SetWindowPos(p r4, p 1, i r0, i r1, i r2, i r3, i 0x0010)i.r9'
    SetCtlColors ${_CONTROL} "475569" "${_COLOR}"
  ${EndIf}
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
!macroend

; Controls and their commands stay native. Only the decoration is owned here.
Function InstallerSetupLeave
  !insertmacro InstallerSetupSave
  ${If} $InstallerSetupReady == "1"
    GetDlgItem $0 $HWNDPARENT 1
    !insertmacro InstallerReleaseButton $0 $InstallerSetupNextImage
    SendMessage $0 ${INSTALLER_WM_SETFONT} $InstallerSetupNavFont 0
    GetDlgItem $0 $HWNDPARENT 3
    !insertmacro InstallerReleaseButton $0 $InstallerSetupBackImage
    SendMessage $0 ${INSTALLER_WM_SETFONT} $InstallerSetupNavFont 0
    GetDlgItem $0 $HWNDPARENT 2
    !insertmacro InstallerReleaseButton $0 $InstallerSetupCancelImage
    SendMessage $0 ${INSTALLER_WM_SETFONT} $InstallerSetupNavFont 0
    !insertmacro InstallerReleaseButton $InstallerSetupBrowseControl $InstallerSetupBrowseImage
    !macro InstallerCombinedDetachFont _CONTROL
      ${If} ${_CONTROL} != ""
      ${AndIf} ${_CONTROL} != "0"
        SendMessage ${_CONTROL} ${INSTALLER_WM_SETFONT} $InstallerSetupNavFont 0
      ${EndIf}
    !macroend
    !insertmacro InstallerCombinedDetachFont $InstallerCombinedCurrentUser
    !insertmacro InstallerCombinedDetachFont $InstallerCombinedAllUsers
    !insertmacro InstallerCombinedDetachFont $InstallerCombinedDirectory
    !insertmacro InstallerCombinedDetachFont $InstallerCombinedBrowse
    !insertmacro InstallerCombinedDetachFont $InstallerCombinedHint
    !insertmacro InstallerCombinedDetachFont $InstallerCombinedSpaceRequired
    !insertmacro InstallerCombinedDetachFont $InstallerCombinedSpaceAvailable
    !insertmacro InstallerCombinedDetachFont $InstallerCombinedScopeLabel
  ${EndIf}
  ${If} $InstallerSetupLogo != "0"
  ${AndIf} $InstallerSetupLogo != ""
    SendMessage $InstallerSetupLogo 0x0172 0 0
    System::Call 'user32::DestroyWindow(p $InstallerSetupLogo)i.r0'
  ${EndIf}
  ${If} $InstallerSetupBitmap != "0"
  ${AndIf} $InstallerSetupBitmap != ""
    System::Call 'gdi32::DeleteObject(p $InstallerSetupBitmap)i.r0'
  ${EndIf}
  ${If} $InstallerSetupFieldLabel != "0"
  ${AndIf} $InstallerSetupFieldLabel != ""
    System::Call 'user32::DestroyWindow(p $InstallerSetupFieldLabel)i.r0'
  ${EndIf}
  ${If} $InstallerSetupHeading != "0"
  ${AndIf} $InstallerSetupHeading != ""
    System::Call 'user32::DestroyWindow(p $InstallerSetupHeading)i.r0'
  ${EndIf}
  ${If} $InstallerSetupSubheading != "0"
  ${AndIf} $InstallerSetupSubheading != ""
    System::Call 'user32::DestroyWindow(p $InstallerSetupSubheading)i.r0'
  ${EndIf}
  StrCpy $InstallerSetupLogo "0"
  StrCpy $InstallerSetupBitmap "0"
  StrCpy $InstallerSetupFieldLabel "0"
  StrCpy $InstallerSetupHeading "0"
  StrCpy $InstallerSetupSubheading "0"
  StrCpy $InstallerSetupBrowseControl "0"
  ${If} $InstallerCombinedDirectorySurface != "0"
  ${AndIf} $InstallerCombinedDirectorySurface != ""
    System::Call 'user32::DestroyWindow(p $InstallerCombinedDirectorySurface)i.r0'
  ${EndIf}
  StrCpy $InstallerCombinedDirectorySurface "0"
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerSetupDestroy
  !insertmacro InstallerSetupSave
  Call InstallerSetupLeave
  ; A silent, updater or elevated-inner path can skip creation altogether.
  ; Normalize absent owned images as well as images released by Leave.
  StrCpy $InstallerSetupNextImage "0"
  StrCpy $InstallerSetupBackImage "0"
  StrCpy $InstallerSetupCancelImage "0"
  StrCpy $InstallerSetupBrowseImage "0"
  ${If} $InstallerSetupFont != "0"
  ${AndIf} $InstallerSetupFont != ""
    System::Call 'gdi32::DeleteObject(p $InstallerSetupFont)i.r0'
  ${EndIf}
  ${If} $InstallerSetupTitleFont != "0"
  ${AndIf} $InstallerSetupTitleFont != ""
    System::Call 'gdi32::DeleteObject(p $InstallerSetupTitleFont)i.r0'
  ${EndIf}
  StrCpy $InstallerSetupFont "0"
  StrCpy $InstallerSetupTitleFont "0"
  StrCpy $InstallerSetupBodyFont "0"
  StrCpy $InstallerSetupReady "0"
  StrCpy $InstallerCombinedReady "0"
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerSetupResetForProgress
  Call InstallerSetupDestroy
FunctionEnd

; SHOW runs before NSIS exposes its native child. Reveal the fully arranged
; page and paint its newly created statics now, rather than waiting for an
; incidental later invalidation while only the original controls are drawn.
Function InstallerSetupReveal
  Push $0
  StrCpy $InstallerWindowPage $InstallerSetupPage
  Call InstallerPresentationOpenMotion
  SendMessage $HWNDPARENT ${JUSTDO_WM_SETREDRAW} 1 0
  ShowWindow $InstallerSetupPage 8
  ShowWindow $HWNDPARENT 4
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x0185)i.r0'
  Pop $0
FunctionEnd

; Called before styling each freshly materialized native page. Starting from
; its real controls also handles Back navigation and a changed installation mode.
Function InstallerSetupPrepare
  !insertmacro InstallerSetupSave
  SendMessage $HWNDPARENT ${JUSTDO_WM_SETREDRAW} 0 0
  Call InstallerSetupDestroy
  StrCpy $InstallerSetupNextImage "0"
  StrCpy $InstallerSetupBackImage "0"
  StrCpy $InstallerSetupCancelImage "0"
  StrCpy $InstallerSetupBrowseImage "0"
  Call InstallerWindowPrepare
  StrCpy $InstallerSetupDpi $InstallerDpi
  StrCpy $InstallerSetupWidth $InstallerWidth
  StrCpy $InstallerSetupHeight $InstallerHeight
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 0x0031 0 0 $InstallerSetupNavFont
  StrCpy $InstallerSetupBodyFont $InstallerSetupNavFont
  StrCpy $3 "Segoe UI"
  ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
  ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
    StrCpy $3 "Microsoft YaHei UI"
  ${EndIf}
  !insertmacro InstallerSetupScale $0 14
  IntOp $0 0 - $0
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w r3)p.s'
  Pop $InstallerSetupFont
  ${If} $InstallerSetupFont != "0"
    StrCpy $InstallerSetupBodyFont $InstallerSetupFont
  ${EndIf}
  !insertmacro InstallerSetupScale $0 20
  IntOp $0 0 - $0
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w r3)p.s'
  Pop $InstallerSetupTitleFont
  StrCpy $InstallerSetupReady "1"

  !insertmacro InstallerSetupScale $0 54
  IntOp $InstallerSetupPageHeight $InstallerSetupHeight - $0
  System::Call 'user32::SetWindowPos(p $InstallerSetupPage, p 1, i 0, i 0, i $InstallerSetupWidth, i $InstallerSetupPageHeight, i 0x0010)i.r0'
  SetCtlColors $HWNDPARENT "${INSTALLER_TEXT_PRIMARY}" "${INSTALLER_BACKGROUND}"
  SetCtlColors $InstallerSetupPage "${INSTALLER_TEXT_PRIMARY}" "${INSTALLER_BACKGROUND}"
  StrCpy $InstallerSetupCompact "0"
  StrCpy $InstallerSetupMinimal "0"
  !insertmacro InstallerSetupScale $0 380
  ${If} $InstallerSetupPageHeight < $0
    StrCpy $InstallerSetupCompact "1"
  ${EndIf}
  !insertmacro InstallerSetupScale $0 360
  ${If} $InstallerSetupPageHeight < $0
    StrCpy $InstallerSetupMinimal "1"
  ${EndIf}

  ; nsDialogs raises its child after SHOW. Mirror the authoritative native
  ; headings inside that child so they remain visible on both kinds of page.
  StrCpy $0 0
  InstallerSetupHideChrome:
  System::Call 'user32::FindWindowExW(p $HWNDPARENT, p r0, p 0, p 0)p.r0'
  ${If} $0 != 0
    System::Call 'user32::GetDlgCtrlID(p r0)i.r1'
    ${If} $0 != $InstallerSetupPage
    ${AndIf} $1 != 1
    ${AndIf} $1 != 2
    ${AndIf} $1 != 3
      ShowWindow $0 0
    ${EndIf}
    Goto InstallerSetupHideChrome
  ${EndIf}
  !insertmacro InstallerSetupScale $0 24
  !insertmacro InstallerSetupScale $1 20
  !insertmacro InstallerSetupScale $2 64
  ${If} $InstallerSetupCompact == "1"
    !insertmacro InstallerSetupScale $1 20
    !insertmacro InstallerSetupScale $2 48
  ${EndIf}
  ${If} $InstallerSetupMinimal != "1"
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5400020E, i r0, i r1, i r2, i r2, p $InstallerSetupPage, p 0, p 0, p 0)p.s'
    Pop $InstallerSetupLogo
    InitPluginsDir
    ; This square asset contains only the original mark. The wider animation
    ; canvas is never stretched into the square header slot.
    ${If} $InstallerSetupDpi >= 192
      File /oname=$PLUGINSDIR\setup-brand.bmp "${INSTALLER_ANIMATION_DIR}\logo-200.bmp"
    ${ElseIf} $InstallerSetupDpi >= 168
      File /oname=$PLUGINSDIR\setup-brand.bmp "${INSTALLER_ANIMATION_DIR}\logo-175.bmp"
    ${ElseIf} $InstallerSetupDpi >= 144
      File /oname=$PLUGINSDIR\setup-brand.bmp "${INSTALLER_ANIMATION_DIR}\logo-150.bmp"
    ${ElseIf} $InstallerSetupDpi >= 120
      File /oname=$PLUGINSDIR\setup-brand.bmp "${INSTALLER_ANIMATION_DIR}\logo-125.bmp"
    ${Else}
      File /oname=$PLUGINSDIR\setup-brand.bmp "${INSTALLER_ANIMATION_DIR}\logo-100.bmp"
    ${EndIf}
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\setup-brand.bmp", i 0, i r2, i r2, i 0x2010)p.s'
    Pop $InstallerSetupBitmap
    SendMessage $InstallerSetupLogo 0x0172 0 $InstallerSetupBitmap
    !insertmacro InstallerSetupScale $3 16
    IntOp $0 $0 + $2
    IntOp $0 $0 + $3
    !insertmacro InstallerSetupScale $3 2
    IntOp $1 $1 + $3
  ${Else}
    !insertmacro InstallerSetupScale $1 14
  ${EndIf}
  !insertmacro InstallerSetupScale $2 24
  IntOp $2 $InstallerSetupWidth - $2
  IntOp $2 $2 - $0
  !insertmacro InstallerSetupScale $3 28
  System::Call 'user32::GetWindowTextW(p $mui.Header.Text, w .r4, i ${NSIS_MAX_STRLEN})i.r9'
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w r4, i 0x54004000, i r0, i r1, i r2, i r3, p $InstallerSetupPage, p 0, p 0, p 0)p.s'
  Pop $InstallerSetupHeading
  ${If} $InstallerSetupTitleFont != "0"
    SendMessage $InstallerSetupHeading ${INSTALLER_WM_SETFONT} $InstallerSetupTitleFont 0
  ${Else}
    SendMessage $InstallerSetupHeading ${INSTALLER_WM_SETFONT} $InstallerSetupBodyFont 0
  ${EndIf}
  SetCtlColors $InstallerSetupHeading "${INSTALLER_TEXT_PRIMARY}" "${INSTALLER_BACKGROUND}"
  IntOp $1 $1 + $3
  !insertmacro InstallerSetupScale $3 40
  ${If} $InstallerSetupMinimal != "1"
    System::Call 'user32::GetWindowTextW(p $mui.Header.SubText, w .r4, i ${NSIS_MAX_STRLEN})i.r9'
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w r4, i 0x54000000, i r0, i r1, i r2, i r3, p $InstallerSetupPage, p 0, p 0, p 0)p.s'
    Pop $InstallerSetupSubheading
    !insertmacro InstallerSetupFont $InstallerSetupSubheading
  ${EndIf}

  !insertmacro InstallerWindowDivider $InstallerSetupPage

  !insertmacro InstallerSetupScale $0 52
  IntOp $1 $InstallerSetupHeight - $0
  !insertmacro InstallerSetupScale $2 112
  !insertmacro InstallerSetupScale $3 36
  !insertmacro InstallerSetupScale $4 24
  !insertmacro InstallerSetupScale $5 12
  IntOp $6 $4 + $5
  IntOp $6 $6 * 2
  IntOp $6 $InstallerSetupWidth - $6
  IntOp $6 $6 / 3
  ${If} $2 > $6
    StrCpy $2 $6
  ${EndIf}
  IntOp $4 $InstallerSetupWidth - $4
  IntOp $4 $4 - $2
  GetDlgItem $0 $HWNDPARENT 2
  !insertmacro InstallerSetupMove $0 $4 $1 $2 $3
  !insertmacro InstallerSetupFont $0
  !insertmacro InstallerPaintButton $0 $InstallerSetupBodyFont $InstallerSetupDpi "${INSTALLER_BUTTON_SECONDARY}" $InstallerSetupCancelImage
  IntOp $4 $4 - $2
  IntOp $4 $4 - $5
  GetDlgItem $0 $HWNDPARENT 1
  !insertmacro InstallerSetupMove $0 $4 $1 $2 $3
  !insertmacro InstallerSetupFont $0
  IntOp $4 $4 - $2
  IntOp $4 $4 - $5
  GetDlgItem $0 $HWNDPARENT 3
  !insertmacro InstallerSetupMove $0 $4 $1 $2 $3
  !insertmacro InstallerSetupFont $0
  !insertmacro InstallerPaintButton $0 $InstallerSetupBodyFont $InstallerSetupDpi "${INSTALLER_BUTTON_SECONDARY}" $InstallerSetupBackImage
  !insertmacro InstallerInitializeButtonCues $HWNDPARENT
  !insertmacro InstallerSetupRestore
FunctionEnd


!macro InstallerSetupPage
  !insertmacro MUI_PAGE_INIT
  PageEx custom
    Caption " "
    PageCallbacks InstallerCombinedCreate InstallerCombinedLeave
  PageExEnd
!macroend

; Scope and directory share one ordinary nsDialogs page. Account defaults,
; shell context and elevation still use electron-builder's supported macros.
Function InstallerCombinedSaveDraft
  !insertmacro InstallerSetupSave
  ${If} $InstallerCombinedReady == "1"
  ${AndIf} $InstallerCombinedLockedDirectory == ""
    ${NSD_GetText} $InstallerCombinedDirectory $0
    ${If} $InstallerCombinedMode == "all"
      StrCpy $InstallerCombinedMachineDraft "$0"
      StrCpy $InstallerCombinedMachineDraftSet "1"
    ${Else}
      StrCpy $InstallerCombinedUserDraft "$0"
      StrCpy $InstallerCombinedUserDraftSet "1"
    ${EndIf}
  ${EndIf}
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerCombinedClearHint
  StrCpy $InstallerCombinedHintIsError "0"
  ${If} $InstallerCombinedLockedMode != ""
    !insertmacro InstallerText $InstallerCombinedHint "检测到现有版本，将沿用原安装范围和目录更新" "Existing version detected. Setup will keep its installation scope and folder."
  ${ElseIf} $InstallerCombinedLockedDirectory != ""
    !insertmacro InstallerText $InstallerCombinedHint "检测到现有版本，将在原目录更新" "Existing version detected. Setup will update it in this folder."
  ${Else}
    SendMessage $InstallerCombinedHint ${JUSTDO_WM_SETTEXT} 0 'STR:'
  ${EndIf}
FunctionEnd

Function InstallerCombinedUpdateActions
  !insertmacro InstallerSetupSave
  GetDlgItem $0 $HWNDPARENT 1
  !insertmacro InstallerText $0 "安装" "Install"
  StrCpy $1 "0"
  ${If} $InstallerCombinedMode == "all"
  ${AndIfNot} ${UAC_IsAdmin}
    StrCpy $1 "1"
  ${EndIf}
  ${If} $1 == "1"
    ; A real native BUTTON owns the live elevation shield.
    !insertmacro InstallerReleaseButton $0 $InstallerSetupNextImage
    SendMessage $0 0x160C 0 1
  ${Else}
    SendMessage $0 0x160C 0 0
    !insertmacro InstallerPaintButton $0 $InstallerSetupBodyFont $InstallerSetupDpi "${INSTALLER_BUTTON_PRIMARY}" $InstallerSetupNextImage
  ${EndIf}
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerCombinedRefreshFacts
  !insertmacro InstallerSetupSave
  ; electron-builder has one installation section (index 0); its normal
  ; space calculation has already run in .onInit. This is information only.
  SectionGetSize 0 $0
  IntOp $0 $0 + 1023
  IntOp $0 $0 / 1024
  !insertmacro InstallerText $InstallerCombinedSpaceRequired "所需空间：$0 MB" "Required: $0 MB"
  !insertmacro InstallerText $InstallerCombinedSpaceAvailable "可用空间：—" "Available: —"
  StrCpy $4 "$InstallerCombinedPath"
  ${Do}
    ${If} $4 == ""
      ${ExitDo}
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w r4)i.r0'
    ${If} $0 != -1
      IntOp $0 $0 & 0x10
      ${If} $0 != 0
        System::Call 'kernel32::GetDiskFreeSpaceExW(w r4, *l .r0, p 0, p 0)i.r1'
        ${If} $1 != 0
          System::Int64Op $0 / 1048576
          Pop $0
          ${If} $0 >= 1024
            IntOp $1 $0 / 1024
            IntOp $2 $0 % 1024
            IntOp $2 $2 * 10
            IntOp $2 $2 / 1024
            !insertmacro InstallerText $InstallerCombinedSpaceAvailable "可用空间：$1.$2 GB" "Available: $1.$2 GB"
          ${Else}
            !insertmacro InstallerText $InstallerCombinedSpaceAvailable "可用空间：$0 MB" "Available: $0 MB"
          ${EndIf}
        ${EndIf}
        ${ExitDo}
      ${EndIf}
    ${EndIf}
    ${GetParent} "$4" $5
    ${If} $5 == $4
      ${ExitDo}
    ${EndIf}
    StrCpy $4 "$5"
  ${Loop}
  !insertmacro InstallerSetupRestore
FunctionEnd

; Interactive upgrades retain a uniquely confirmed scope. Explicit deployment flags
; continue to select a scope, and the UAC inner/updater paths skip this resolver.
Function InstallerCombinedResolveUpgradeMode
  !insertmacro InstallerSetupSave
  StrCpy $InstallerCombinedLockedMode ""
  StrCpy $0 "not-inspected"
  StrCpy $1 "not-inspected"
  StrCpy $2 ""
  StrCpy $3 ""
  ${If} $InstallerCombinedForcedMode == ""
    StrCpy $InstallerLookupMode "CurrentUser"
    Call InstallerResolveRegisteredDirectory
    StrCpy $0 "$InstallerLookupState"
    StrCpy $2 "$InstallerLookupDirectory"
    StrCpy $InstallerLookupMode "all"
    Call InstallerResolveRegisteredDirectory
    StrCpy $1 "$InstallerLookupState"
    StrCpy $3 "$InstallerLookupDirectory"
    ${If} $0 == "confirmed"
    ${AndIf} $1 == "missing"
      StrCpy $InstallerCombinedLockedMode "CurrentUser"
    ${ElseIf} $0 == "missing"
    ${AndIf} $1 == "confirmed"
      StrCpy $InstallerCombinedLockedMode "all"
    ${EndIf}
  ${EndIf}
  ${If} $InstallerCombinedLockedMode != ""
    StrCpy $InstallerCombinedMode "$InstallerCombinedLockedMode"
  ${EndIf}
  !insertmacro JustDoLogInstallEvent "phase=setup-target-resolution current-user-state=$0 current-user-dir=$2 all-users-state=$1 all-users-dir=$3 selected-mode=$InstallerCombinedMode locked-mode=$InstallerCombinedLockedMode"
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerCombinedApplyMode
  !insertmacro InstallerSetupSave
  StrCpy $InstallerCombinedUpdating "1"
  ${If} $InstallerCombinedLockedMode != ""
    StrCpy $InstallerCombinedMode "$InstallerCombinedLockedMode"
  ${EndIf}
  ${If} $InstallerCombinedMode == "all"
    !ifmacrodef setInstallModePerAllUsers
      !insertmacro setInstallModePerAllUsers
    !endif
  ${Else}
    !ifmacrodef setInstallModePerUser
      !insertmacro setInstallModePerUser
    !endif
  ${EndIf}
  Call InstallerRestoreUpgradeDirectory
  StrCpy $InstallerCombinedLockedDirectory "$InstallerUpgradeDirectory"
  StrCpy $InstallerCombinedPath "$INSTDIR"
  ${If} $InstallerCombinedLockedDirectory == ""
    ${If} $InstallerCombinedMode == "all"
    ${AndIf} $InstallerCombinedMachineDraftSet == "1"
      StrCpy $InstallerCombinedPath "$InstallerCombinedMachineDraft"
    ${ElseIf} $InstallerCombinedMode != "all"
    ${AndIf} $InstallerCombinedUserDraftSet == "1"
      StrCpy $InstallerCombinedPath "$InstallerCombinedUserDraft"
    ${EndIf}
  ${EndIf}
  ${NSD_SetText} $InstallerCombinedDirectory "$InstallerCombinedPath"
  SendMessage $InstallerCombinedCurrentUser ${BM_SETCHECK} 0 0
  SendMessage $InstallerCombinedAllUsers ${BM_SETCHECK} 0 0
  ${If} $InstallerCombinedMode == "all"
    SendMessage $InstallerCombinedAllUsers ${BM_SETCHECK} ${BST_CHECKED} 0
  ${Else}
    SendMessage $InstallerCombinedCurrentUser ${BM_SETCHECK} ${BST_CHECKED} 0
  ${EndIf}
  StrCpy $0 1
  ${If} $InstallerCombinedLockedDirectory != ""
    StrCpy $0 0
  ${EndIf}
  !ifndef allowToChangeInstallationDirectory
    StrCpy $0 0
  !endif
  EnableWindow $InstallerCombinedDirectory $0
  EnableWindow $InstallerCombinedBrowse $0
  Call InstallerCombinedStyleBrowse
  Call InstallerCombinedClearHint
  Call InstallerCombinedUpdateActions
  Call InstallerCombinedRefreshFacts
  StrCpy $InstallerCombinedUpdating "0"
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerCombinedScopeChanged
  Pop $InstallerCombinedEvent
  !insertmacro InstallerSetupSave
  ${If} $InstallerCombinedEvent != $InstallerCombinedCurrentUser
  ${AndIf} $InstallerCombinedEvent != $InstallerCombinedAllUsers
    Goto InstallerCombinedScopeDone
  ${EndIf}
  Call InstallerCombinedSaveDraft
  ${If} $InstallerCombinedLockedMode != ""
    StrCpy $InstallerCombinedMode "$InstallerCombinedLockedMode"
  ${ElseIf} $InstallerCombinedForcedMode != ""
    StrCpy $InstallerCombinedMode "$InstallerCombinedForcedMode"
  ${ElseIf} $InstallerCombinedEvent == $InstallerCombinedAllUsers
    !ifmacrodef setInstallModePerAllUsers
      StrCpy $InstallerCombinedMode "all"
    !else
      Goto InstallerCombinedScopeDone
    !endif
  ${Else}
    !ifmacrodef setInstallModePerUser
      StrCpy $InstallerCombinedMode "CurrentUser"
    !else
      Goto InstallerCombinedScopeDone
    !endif
  ${EndIf}
  Call InstallerCombinedApplyMode
  InstallerCombinedScopeDone:
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerCombinedDirectoryChanged
  Pop $InstallerCombinedEvent
  ${If} $InstallerCombinedUpdating != "1"
    ${If} $InstallerCombinedHintIsError == "1"
      Call InstallerCombinedClearHint
    ${EndIf}
    ; Do not query a partial UNC path while the user is typing.
    !insertmacro InstallerText $InstallerCombinedSpaceAvailable "可用空间：—" "Available: —"
  ${EndIf}
FunctionEnd

Function InstallerCombinedBrowseClicked
  Pop $InstallerCombinedEvent
  !insertmacro InstallerSetupSave
  ${NSD_GetText} $InstallerCombinedDirectory $0
  nsDialogs::SelectFolderDialog /NOUNLOAD "" "$0"
  Pop $1
  ${If} $1 != "error"
    ${NSD_SetText} $InstallerCombinedDirectory "$1"
    StrCpy $InstallerCombinedPath "$1"
    Call InstallerCombinedRefreshFacts
  ${EndIf}
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerCombinedDirectorySurfaceClicked
  Pop $InstallerCombinedEvent
  !insertmacro InstallerSetupSave
  System::Call 'user32::IsWindowEnabled(p $InstallerCombinedDirectory)i.r0'
  ${If} $0 != 0
    System::Call 'user32::SetFocus(p $InstallerCombinedDirectory)p.r0'
  ${EndIf}
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerCombinedStyleBrowse
  !insertmacro InstallerSetupSave
  System::Call 'user32::IsWindowEnabled(p $InstallerCombinedBrowse)i.r0'
  StrCpy $1 "${INSTALLER_BUTTON_SECONDARY}"
  ${If} $0 != 0
    StrCpy $1 "${INSTALLER_BUTTON_ACCENT}"
  ${EndIf}
  ${If} $InstallerSetupMinimal != "1"
    !insertmacro InstallerPaintButtonOnSurface $InstallerCombinedBrowse $InstallerSetupBodyFont $InstallerSetupDpi "$1" 0xF8F4F3 $InstallerSetupBrowseImage
  ${Else}
    !insertmacro InstallerPaintButton $InstallerCombinedBrowse $InstallerSetupBodyFont $InstallerSetupDpi "$1" $InstallerSetupBrowseImage
  ${EndIf}
  !insertmacro InstallerSetupRestore
FunctionEnd


; Pure path checks do not assign INSTDIR or create any filesystem entries.
Function InstallerCombinedCheckPathSyntax
  !insertmacro InstallerSetupSave
  StrCpy $InstallerCombinedPathValid "0"
  ${If} $InstallerCombinedPath != ""
    StrCpy $0 $InstallerCombinedPath 2
    ${If} $0 == "\\"
      ; StdUtils accepts drive paths. Validate UNC components against a
      ; synthetic drive before checking the actual share's root below.
      StrCpy $0 $InstallerCombinedPath "" 2
      ${StdUtils.ValidPathSpec} $1 "C:\$0"
    ${Else}
      ${StdUtils.ValidPathSpec} $1 "$InstallerCombinedPath"
    ${EndIf}
    ${If} $1 == "ok"
      StrCpy $InstallerCombinedPathValid "1"
    ${EndIf}
  ${EndIf}
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerCombinedCheckFinalPath
  !insertmacro InstallerSetupSave
  Call InstallerCombinedCheckPathSyntax
  ${If} $InstallerCombinedPathValid != "1"
    Goto InstallerCombinedFinalChecked
  ${EndIf}
  StrCpy $InstallerCombinedPathValid "0"
  ${GetRoot} "$InstallerCombinedPath" $2
  ${If} $2 == ""
  ${OrIf} $InstallerCombinedPath == $2
  ${OrIf} $InstallerCombinedPath == "$2\"
    Goto InstallerCombinedFinalChecked
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w "$2\")i.r0'
  ${If} $0 == -1
    Goto InstallerCombinedFinalChecked
  ${EndIf}
  IntOp $0 $0 & 0x10
  ${If} $0 == 0
    Goto InstallerCombinedFinalChecked
  ${EndIf}
  StrCpy $4 "$InstallerCombinedPath"
  ${Do}
    ${If} $4 == $2
    ${OrIf} $4 == "$2\"
      ${ExitDo}
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w r4)i.r0'
    ${If} $0 != -1
      IntOp $0 $0 & 0x10
      ${If} $0 == 0
        Goto InstallerCombinedFinalChecked
      ${EndIf}
    ${EndIf}
    ${GetParent} "$4" $5
    ${If} $5 == ""
    ${OrIf} $5 == $4
      Goto InstallerCombinedFinalChecked
    ${EndIf}
    StrCpy $4 "$5"
  ${Loop}
  StrCpy $InstallerCombinedPathValid "1"
  InstallerCombinedFinalChecked:
  !insertmacro InstallerSetupRestore
FunctionEnd

; Validate the raw edit before assigning to INSTDIR: special path variables
; are sanitized by NSIS, which must not silently change invalid typed input.
Function InstallerCombinedValidateDirectory
  !insertmacro InstallerSetupSave
  StrCpy $InstallerCombinedPathValid "0"
  Call InstallerRestoreUpgradeDirectory
  StrCpy $InstallerCombinedLockedDirectory "$InstallerUpgradeDirectory"
  ${If} $InstallerCombinedLockedDirectory != ""
    StrCpy $InstallerCombinedPath "$InstallerCombinedLockedDirectory"
  ${Else}
    System::Call 'user32::GetWindowTextLengthW(p $InstallerCombinedDirectory)i.r0'
    ${If} $0 > ${INSTALLER_COMBINED_PATH_LIMIT}
      Goto InstallerCombinedInvalidDirectory
    ${EndIf}
    ${NSD_GetText} $InstallerCombinedDirectory $InstallerCombinedPath
  ${EndIf}
  Call InstallerCombinedCheckPathSyntax
  ${If} $InstallerCombinedPathValid != "1"
    Goto InstallerCombinedInvalidDirectory
  ${EndIf}
  ${If} $InstallerCombinedLockedDirectory == ""
    ${StdUtils.NormalizePath} $0 "$InstallerCombinedPath"
    StrCpy $INSTDIR "$0"
    !ifdef allowToChangeInstallationDirectory
      Call instFilesPre
    !endif
    StrCpy $InstallerCombinedPath "$INSTDIR"
  ${EndIf}
  Call InstallerCombinedCheckFinalPath
  ${If} $InstallerCombinedPathValid != "1"
    Goto InstallerCombinedInvalidDirectory
  ${EndIf}
  StrCpy $InstallerCombinedSelectionPath "$InstallerCombinedPath"
  StrCpy $INSTDIR "$InstallerCombinedSelectionPath"
  Call InstallerCombinedRefreshFacts
  Goto InstallerCombinedValidateDone
  InstallerCombinedInvalidDirectory:
  StrCpy $InstallerCombinedPathValid "0"
  StrCpy $InstallerCombinedHintIsError "1"
  !insertmacro InstallerText $InstallerCombinedHint "请选择有效的安装目录" "Choose a valid installation folder"
  System::Call 'user32::SetFocus(p $InstallerCombinedDirectory)p.r0'
  InstallerCombinedValidateDone:
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerCombinedEnsureElevation
  !insertmacro InstallerSetupSave
  StrCpy $InstallerCombinedElevationResult "ok"
  ${If} $InstallerCombinedMode == "all"
  ${AndIfNot} ${UAC_IsAdmin}
    ShowWindow $HWNDPARENT 0
    !insertmacro UAC_RunElevated
    !insertmacro JustDoLogInstallEvent "phase=setup-elevation-result result=$0 wrapper=$1 child-exit=$2"
    ${If} $0 == 0
    ${AndIf} $1 == 1
    ${AndIf} $2 != 0x666666
      SetErrorLevel $2
      !insertmacro InstallerSetupRestore
      Quit
    ${EndIf}
    ${If} $0 == 0
    ${AndIf} $1 == 2
    ${AndIf} ${UAC_IsAdmin}
      ; Already elevated: continue this same page's accepted action.
    ${Else}
      ShowWindow $HWNDPARENT 5
      BringToFront
      StrCpy $InstallerCombinedElevationResult "cancelled"
      StrCpy $InstallerCombinedHintIsError "1"
      ${If} $0 == 1223
        !insertmacro InstallerText $InstallerCombinedHint "已取消管理员授权" "Administrator approval was cancelled"
      ${Else}
        !insertmacro InstallerText $InstallerCombinedHint "未获得管理员权限，请重试" "Administrator privileges are required; try again"
      ${EndIf}
      StrCpy $InstallerCombinedSelectionReady "0"
    ${EndIf}
  ${EndIf}
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerCombinedCreate
  !insertmacro InstallerSetupSave
  ${If} ${UAC_IsInnerInstance}
    ${IfNot} ${UAC_IsAdmin}
      SetErrorLevel 0x666666
      !insertmacro InstallerSetupRestore
      Quit
    ${EndIf}
    StrCpy $InstallerCombinedHandoffReady "0"
    StrCpy $InstallerCombinedHandoffPath ""
    StrCpy $0 ""
    ClearErrors
    !insertmacro UAC_AsUser_GetGlobal $InstallerCombinedHandoffReady $InstallerCombinedSelectionReady
    IfErrors InstallerCombinedHandoffFailed
    ${If} $InstallerCombinedHandoffReady != "1"
      Goto InstallerCombinedHandoffFailed
    ${EndIf}
    StrCpy $0 ""
    ClearErrors
    !insertmacro UAC_AsUser_GetGlobal $InstallerCombinedHandoffPath $InstallerCombinedSelectionPath
    IfErrors InstallerCombinedHandoffFailed
    ; Validate the transported final path without assigning a special path
    ; variable. A failed bridge cannot turn a stale register into a target.
    StrCpy $InstallerCombinedPath "$InstallerCombinedHandoffPath"
    Call InstallerCombinedCheckFinalPath
    ${If} $InstallerCombinedPathValid != "1"
      Goto InstallerCombinedHandoffFailed
    ${EndIf}
    StrCpy $InstallerCombinedSelectionPath "$InstallerCombinedPath"
    StrCpy $InstallerCombinedMode "all"
    !ifmacrodef setInstallModePerAllUsers
      !insertmacro setInstallModePerAllUsers
    !endif
    Call InstallerRestoreUpgradeDirectory
    ${If} $InstallerUpgradeDirectory != ""
      StrCpy $InstallerCombinedPath "$InstallerUpgradeDirectory"
      Call InstallerCombinedCheckFinalPath
      ${If} $InstallerCombinedPathValid != "1"
        Goto InstallerCombinedHandoffFailed
      ${EndIf}
      StrCpy $InstallerCombinedSelectionPath "$InstallerCombinedPath"
    ${EndIf}
    StrCpy $INSTDIR "$InstallerCombinedSelectionPath"
    StrCpy $InstallerCombinedSelectionReady "1"
    !insertmacro InstallerSetupRestore
    Abort
    InstallerCombinedHandoffFailed:
    !insertmacro JustDoLogInstallEvent "phase=setup-handoff-rejected reason=invalid-or-unavailable-target"
    SetErrorLevel 2
    !insertmacro InstallerSetupRestore
    Quit
  ${EndIf}
  StrCpy $InstallerCombinedMode "$installMode"
  ${If} $InstallerCombinedMode != "all"
    StrCpy $InstallerCombinedMode "CurrentUser"
  ${EndIf}
  ${If} ${isUpdated}
    ; Updaters retain their skipped setup UI. Only a machine update needs this
    ; interactive handoff; silent elevation remains the upstream section's job.
    StrCpy $InstallerCombinedSelectionPath "$INSTDIR"
    StrCpy $InstallerCombinedSelectionReady "1"
    Call InstallerCombinedEnsureElevation
    ${If} $InstallerCombinedElevationResult != "ok"
      SetErrorLevel 2
      !insertmacro InstallerSetupRestore
      Quit
    ${EndIf}
    !insertmacro InstallerSetupRestore
    Abort
  ${EndIf}
  StrCpy $InstallerCombinedForcedMode ""
  !ifdef INSTALL_MODE_PER_ALL_USERS
    StrCpy $InstallerCombinedForcedMode "all"
  !else
    ${If} ${isForCurrentUser}
      StrCpy $InstallerCombinedForcedMode "CurrentUser"
    ${ElseIf} ${isForAllUsers}
      StrCpy $InstallerCombinedForcedMode "all"
    ${EndIf}
  !endif
  ${If} $InstallerCombinedForcedMode != ""
    StrCpy $InstallerCombinedMode "$InstallerCombinedForcedMode"
  ${EndIf}
  Call InstallerCombinedResolveUpgradeMode
  nsDialogs::Create 1018
  Pop $InstallerCombinedPage
  ${If} $InstallerCombinedPage == "error"
    SetErrorLevel 2
    !insertmacro InstallerSetupRestore
    Quit
  ${EndIf}
  StrCpy $InstallerSetupPage $InstallerCombinedPage
  !insertmacro InstallerText $mui.Header.Text "安装 ${PRODUCT_NAME}" "Install ${PRODUCT_NAME}"
  !insertmacro InstallerText $mui.Header.SubText "安装设置" "Installation options"
  Call InstallerSetupPrepare
  StrCpy $InstallerCombinedReady "0"
  StrCpy $InstallerCombinedUpdating "1"
  StrCpy $InstallerCombinedUserDraftSet "0"
  StrCpy $InstallerCombinedMachineDraftSet "0"
  StrCpy $InstallerCombinedSelectionReady "0"

  ${NSD_CreateLabel} 0 0 1 1 ""
  Pop $InstallerCombinedScopeLabel
  !insertmacro InstallerText $InstallerCombinedScopeLabel "安装范围" "Install for"
  ${NSD_CreateRadioButton} 0 0 1 1 ""
  Pop $InstallerCombinedCurrentUser
  System::Call 'user32::GetWindowLongW(p $InstallerCombinedCurrentUser, i -16)i.r0'
  IntOp $0 $0 | 0x00020000
  System::Call 'user32::SetWindowLongW(p $InstallerCombinedCurrentUser, i -16, i r0)i.r9'
  !insertmacro InstallerText $InstallerCombinedCurrentUser "仅为我安装" "Only me"
  ${NSD_CreateRadioButton} 0 0 1 1 ""
  Pop $InstallerCombinedAllUsers
  !insertmacro InstallerText $InstallerCombinedAllUsers "为所有用户安装" "All users"
  ${NSD_CreateLabel} 0 0 1 1 ""
  Pop $InstallerSetupFieldLabel
  ; End the preceding auto-radio group before the directory edit and Browse.
  System::Call 'user32::GetWindowLongW(p $InstallerSetupFieldLabel, i -16)i.r0'
  IntOp $0 $0 | 0x00020000
  System::Call 'user32::SetWindowLongW(p $InstallerSetupFieldLabel, i -16, i r0)i.r9'
  !insertmacro InstallerText $InstallerSetupFieldLabel "安装目录" "Install folder"
  ${NSD_CreateLabel} 0 0 1 1 ""
  Pop $InstallerCombinedDirectorySurface
  System::Call 'user32::GetWindowLongW(p $InstallerCombinedDirectorySurface, i -16)i.r0'
  IntOp $0 $0 | 0x00000100
  System::Call 'user32::SetWindowLongW(p $InstallerCombinedDirectorySurface, i -16, i r0)i.r9'
  SetCtlColors $InstallerCombinedDirectorySurface "FFFFFF" "FFFFFF"
  ${NSD_CreateText} 0 0 1 1 ""
  Pop $InstallerCombinedDirectory
  SendMessage $InstallerCombinedDirectory 0x00C5 ${INSTALLER_COMBINED_PATH_LIMIT} 0
  ${NSD_CreateButton} 0 0 1 1 ""
  Pop $InstallerCombinedBrowse
  !insertmacro InstallerText $InstallerCombinedBrowse "浏览" "Browse"
  ${NSD_CreateLabel} 0 0 1 1 ""
  Pop $InstallerCombinedHint
  ${NSD_CreateLabel} 0 0 1 1 ""
  Pop $InstallerCombinedSpaceRequired
  ${NSD_CreateLabel} 0 0 1 1 ""
  Pop $InstallerCombinedSpaceAvailable
  StrCpy $InstallerSetupBrowseControl $InstallerCombinedBrowse

  !insertmacro InstallerSetupScale $0 40
  IntOp $2 $0 * 2
  IntOp $2 $InstallerSetupWidth - $2
  !insertmacro InstallerSetupScale $1 130
  ${If} $InstallerSetupCompact == "1"
    !insertmacro InstallerSetupScale $1 112
  ${EndIf}
  !insertmacro InstallerSetupScale $3 22
  !insertmacro InstallerSetupMove $InstallerCombinedScopeLabel $0 $1 $2 $3
  !insertmacro InstallerSetupScale $1 158
  !insertmacro InstallerSetupScale $3 32
  ${If} $InstallerSetupCompact == "1"
    !insertmacro InstallerSetupScale $1 140
  ${EndIf}
  ${If} $InstallerSetupMinimal == "1"
    ShowWindow $InstallerSetupHeading 0
    ShowWindow $InstallerSetupSubheading 0
    ShowWindow $InstallerCombinedScopeLabel 0
    !insertmacro InstallerSetupScale $1 12
    !insertmacro InstallerSetupScale $3 28
  ${EndIf}
  !insertmacro InstallerSetupScale $4 12
  IntOp $5 $2 - $4
  IntOp $5 $5 / 2
  !insertmacro InstallerSetupMove $InstallerCombinedCurrentUser $0 $1 $5 $3
  IntOp $6 $0 + $5
  IntOp $6 $6 + $4
  !insertmacro InstallerSetupMove $InstallerCombinedAllUsers $6 $1 $5 $3
  !insertmacro InstallerSetupScale $1 216
  ${If} $InstallerSetupCompact == "1"
    !insertmacro InstallerSetupScale $1 184
  ${EndIf}
  ${If} $InstallerSetupMinimal == "1"
    !insertmacro InstallerSetupScale $1 48
  ${EndIf}
  !insertmacro InstallerSetupScale $3 22
  !insertmacro InstallerSetupMove $InstallerSetupFieldLabel $0 $1 $2 $3
  !insertmacro InstallerSetupScale $4 30
  IntOp $1 $1 + $4
  !insertmacro InstallerSetupScale $3 36
  ${If} $InstallerSetupMinimal == "1"
    !insertmacro InstallerSetupScale $3 32
  ${EndIf}
  !insertmacro InstallerSetupScale $4 112
  !insertmacro InstallerSetupScale $5 12
  IntOp $6 $2 - $4
  IntOp $6 $6 - $5
  !insertmacro InstallerSetupMove $InstallerCombinedDirectory $0 $1 $6 $3
  !insertmacro InstallerSetupMove $InstallerCombinedDirectorySurface $0 $1 $6 $3
  IntOp $6 $6 + $0
  IntOp $6 $6 + $5
  !insertmacro InstallerSetupMove $InstallerCombinedBrowse $6 $1 $4 $3
  ; The inner HWND supplies horizontal padding; avoid a second native margin.
  SendMessage $InstallerCombinedDirectory 0x00D3 3 0
  !insertmacro InstallerSetupScale $4 10
  IntOp $1 $1 + $3
  IntOp $1 $1 + $4
  !insertmacro InstallerSetupScale $3 26
  !insertmacro InstallerSetupMove $InstallerCombinedHint $0 $1 $2 $3
  !insertmacro InstallerSetupScale $4 34
  IntOp $1 $1 + $4
  !insertmacro InstallerSetupScale $3 22
  !insertmacro InstallerSetupScale $4 12
  IntOp $5 $2 - $4
  IntOp $5 $5 / 2
  !insertmacro InstallerSetupMove $InstallerCombinedSpaceRequired $0 $1 $5 $3
  IntOp $6 $0 + $5
  IntOp $6 $6 + $4
  !insertmacro InstallerSetupMove $InstallerCombinedSpaceAvailable $6 $1 $5 $3
  ${If} $InstallerSetupMinimal == "1"
    ShowWindow $InstallerCombinedSpaceRequired 0
    ShowWindow $InstallerCombinedSpaceAvailable 0
    !insertmacro InstallerSetupScale $0 140
    ${If} $InstallerSetupPageHeight < $0
      ShowWindow $InstallerCombinedHint 0
    ${EndIf}
  ${EndIf}

  !macro InstallerCombinedFont _CONTROL
    !insertmacro InstallerSetupFont ${_CONTROL}
    ${If} $InstallerSetupMinimal != "1"
      SetCtlColors ${_CONTROL} "475569" "F3F4F8"
    ${EndIf}
  !macroend
  !insertmacro InstallerCombinedFont $InstallerCombinedScopeLabel
  !insertmacro InstallerCombinedFont $InstallerCombinedCurrentUser
  !insertmacro InstallerCombinedFont $InstallerCombinedAllUsers
  !insertmacro InstallerCombinedFont $InstallerSetupFieldLabel
  !insertmacro InstallerCombinedFont $InstallerCombinedDirectory
  !insertmacro InstallerCombinedFont $InstallerCombinedBrowse
  !insertmacro InstallerCombinedFont $InstallerCombinedHint
  !insertmacro InstallerCombinedFont $InstallerCombinedSpaceRequired
  !insertmacro InstallerCombinedFont $InstallerCombinedSpaceAvailable
  SetCtlColors $InstallerCombinedDirectory "475569" "FFFFFF"
  Call InstallerCombinedStyleDirectory
  ${If} $InstallerSetupMinimal != "1"
    ${If} $InstallerSetupCompact == "1"
      !insertmacro InstallerSetupCard $InstallerCombinedScopeLabel 12355 104 232 "F3F4F8"
    ${Else}
      !insertmacro InstallerSetupCard $InstallerCombinedScopeLabel 12355 124 244 "F3F4F8"
    ${EndIf}
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 0
  EnableWindow $0 0
  System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i 0, i 0, i 0x0016)i.r9'
  ${If} $InstallerCombinedLockedMode != ""
    EnableWindow $InstallerCombinedCurrentUser 0
    EnableWindow $InstallerCombinedAllUsers 0
  ${ElseIf} $InstallerCombinedForcedMode == "all"
    EnableWindow $InstallerCombinedCurrentUser 0
  ${ElseIf} $InstallerCombinedForcedMode == "CurrentUser"
    EnableWindow $InstallerCombinedAllUsers 0
  ${EndIf}
  !ifmacrodef setInstallModePerUser
  !else
    EnableWindow $InstallerCombinedCurrentUser 0
  !endif
  !ifmacrodef setInstallModePerAllUsers
  !else
    EnableWindow $InstallerCombinedAllUsers 0
  !endif
  ${NSD_OnClick} $InstallerCombinedCurrentUser InstallerCombinedScopeChanged
  ${NSD_OnClick} $InstallerCombinedAllUsers InstallerCombinedScopeChanged
  ${NSD_OnClick} $InstallerCombinedBrowse InstallerCombinedBrowseClicked
  ${NSD_OnClick} $InstallerCombinedDirectorySurface InstallerCombinedDirectorySurfaceClicked
  ${NSD_OnChange} $InstallerCombinedDirectory InstallerCombinedDirectoryChanged
  StrCpy $InstallerCombinedReady "1"
  Call InstallerCombinedApplyMode
  Call InstallerSetupReveal
  !insertmacro InstallerSetupRestore
  nsDialogs::Show
FunctionEnd

Function InstallerCombinedLeave
  Call InstallerCombinedSaveDraft
  ${If} $InstallerCombinedLockedMode != ""
    Call InstallerCombinedApplyMode
  ${EndIf}
  Call InstallerCombinedValidateDirectory
  ${If} $InstallerCombinedPathValid != "1"
    Abort
  ${EndIf}
  StrCpy $InstallerCombinedSelectionReady "1"
  Call InstallerCombinedEnsureElevation
  ${If} $InstallerCombinedElevationResult != "ok"
    Abort
  ${EndIf}
  StrCpy $INSTDIR "$InstallerCombinedSelectionPath"
  StrCpy $JustDoInstallMode "$installMode"
  Call InstallerSetupDestroy
FunctionEnd

; A single-line EDIT paints at its client top and ignores EM_SETRECT. Keep
; that native edit at its actual font line height, centered in a rounded white
; surface. Native input, selection, horizontal scrolling and Tab stay intact.
Function InstallerCombinedStyleDirectory
  !insertmacro InstallerSetupSave
  ; nsDialogs preserves creation order for keyboard navigation. Keep this
  ; decorative peer behind the edit; the main card is sent below it later.
  System::Call 'user32::SetWindowPos(p $InstallerCombinedDirectorySurface, p 1, i 0, i 0, i 0, i 0, i 0x0013)i.r9'
  System::Call 'user32::GetWindowLongW(p $InstallerCombinedDirectory, i -16)i.r0'
  IntOp $0 $0 & 0xFF7FFFFF
  System::Call 'user32::SetWindowLongW(p $InstallerCombinedDirectory, i -16, i r0)i.r9'
  System::Call 'user32::GetWindowLongW(p $InstallerCombinedDirectory, i -20)i.r0'
  IntOp $0 $0 & 0xFFFFFCFF
  System::Call 'user32::SetWindowLongW(p $InstallerCombinedDirectory, i -20, i r0)i.r9'
  System::Call 'user32::SetWindowPos(p $InstallerCombinedDirectory, p 0, i 0, i 0, i 0, i 0, i 0x0037)i.r9'
  System::Alloc 16
  Pop $0
  ${If} $0 != 0
    System::Call 'user32::GetClientRect(p $InstallerCombinedDirectorySurface, p r0)i.r9'
    ${If} $9 != 0
      System::Call '*$0(i, i, i .r1, i .r2)'
      IntOp $1 $1 + 1
      IntOp $2 $2 + 1
      !insertmacro InstallerSetupScale $3 12
      System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i r1, i r2, i r3, i r3)p.r4'
      ${If} $4 != 0
        System::Call 'user32::SetWindowRgn(p $InstallerCombinedDirectorySurface, p r4, i 1)i.r9'
        ${If} $9 == 0
          System::Call 'gdi32::DeleteObject(p r4)i.r9'
        ${EndIf}
      ${EndIf}
    ${EndIf}
    System::Call 'user32::GetWindowRect(p $InstallerCombinedDirectorySurface, p r0)i.r9'
    ${If} $9 != 0
      System::Call 'user32::MapWindowPoints(p 0, p $InstallerCombinedPage, p r0, i 2)i.r9'
      System::Call '*$0(i .r1, i .r2, i .r3, i .r4)'
      IntOp $3 $3 - $1
      IntOp $4 $4 - $2
      !insertmacro InstallerSetupScale $8 20
      System::Call 'user32::GetDC(p $InstallerCombinedDirectory)p.r5'
      ${If} $5 != 0
        System::Call 'gdi32::SelectObject(p r5, p $InstallerSetupBodyFont)p.r6'
        System::Alloc 60
        Pop $7
        ${If} $7 != 0
          System::Call 'gdi32::GetTextMetricsW(p r5, p r7)i.r9'
          ${If} $9 != 0
            System::Call '*$7(i .r8)'
          ${EndIf}
          System::Free $7
        ${EndIf}
        System::Call 'gdi32::SelectObject(p r5, p r6)p.r9'
        System::Call 'user32::ReleaseDC(p $InstallerCombinedDirectory, p r5)i.r9'
      ${EndIf}
      ${If} $8 < 1
      ${OrIf} $8 > $4
        StrCpy $8 $4
      ${EndIf}
      IntOp $4 $4 - $8
      IntOp $4 $4 / 2
      IntOp $2 $2 + $4
      !insertmacro InstallerSetupScale $4 10
      IntOp $1 $1 + $4
      IntOp $4 $4 * 2
      IntOp $3 $3 - $4
      System::Call 'user32::SetWindowPos(p $InstallerCombinedDirectory, p 0, i r1, i r2, i r3, i r8, i 0x0014)i.r9'
    ${EndIf}
    System::Free $0
  ${EndIf}
  !insertmacro InstallerSetupRestore
FunctionEnd

!endif
