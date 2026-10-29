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
  Push $R9
  StrCpy $R9 "0"
  ${If} ${Errors}
    StrCpy $R9 "1"
  ${EndIf}
!macroend

!macro InstallerSetupRestore
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
  !insertmacro InstallerSetupRestore
FunctionEnd

Function InstallerSetupDestroy
  !insertmacro InstallerSetupSave
  Call InstallerSetupLeave
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
  ShowWindow $InstallerSetupPage 8
  ShowWindow $HWNDPARENT 4
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x0185)i.r0'
  Pop $0
FunctionEnd

; Called before styling each freshly materialized native page. Starting from
; its real controls also handles Back navigation and a changed installation mode.
Function InstallerSetupPrepare
  !insertmacro InstallerSetupSave
  Call InstallerSetupDestroy
  StrCpy $InstallerSetupNextImage "0"
  StrCpy $InstallerSetupBackImage "0"
  StrCpy $InstallerSetupCancelImage "0"
  StrCpy $InstallerSetupBrowseImage "0"
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT)i.r0'
  ${If} $0 < 96
    StrCpy $0 96
  ${EndIf}
  StrCpy $InstallerSetupDpi $0
  !ifmacrodef InstallerSetupWorkArea
    !insertmacro InstallerSetupWorkArea
  !endif
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
  !insertmacro InstallerSetupScale $0 26
  IntOp $0 0 - $0
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 500, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w r3)p.s'
  Pop $InstallerSetupTitleFont
  StrCpy $InstallerSetupReady "1"

  Call InstallerPresentationChrome
  System::Call 'user32::MonitorFromWindow(p $HWNDPARENT, i 2)p.r0'
  System::Call '*(i 40, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0)p.r1'
  System::Call 'user32::GetMonitorInfoW(p r0, p r1)i.r2'
  System::Call '*$1(i, i, i, i, i, i .r2, i .r3, i .r4, i .r5)'
  System::Free $1
  IntOp $4 $4 - $2
  IntOp $5 $5 - $3
  !ifmacrodef InstallerSetupClampWorkArea
    !insertmacro InstallerSetupClampWorkArea
  !endif
  System::Alloc 16
  Pop $0
  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r0)i.r1'
  System::Call '*$0(i .r6, i .r7, i .r8, i .r9)'
  IntOp $8 $8 - $6
  IntOp $9 $9 - $7
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r0)i.r1'
  System::Call '*$0(i, i, i .r6, i .r7)'
  System::Free $0
  IntOp $8 $8 - $6
  IntOp $9 $9 - $7
  !insertmacro InstallerSetupScale $InstallerSetupWidth 680
  !insertmacro InstallerSetupScale $InstallerSetupHeight 600
  !insertmacro InstallerSetupScale $0 32
  IntOp $6 $4 - $0
  IntOp $6 $6 - $8
  ${If} $InstallerSetupWidth > $6
    StrCpy $InstallerSetupWidth $6
  ${EndIf}
  IntOp $6 $5 - $0
  IntOp $6 $6 - $9
  ${If} $InstallerSetupHeight > $6
    StrCpy $InstallerSetupHeight $6
  ${EndIf}
  IntOp $6 $InstallerSetupWidth + $8
  IntOp $7 $InstallerSetupHeight + $9
  IntOp $4 $4 - $6
  IntOp $4 $4 / 2
  IntOp $2 $2 + $4
  IntOp $5 $5 - $7
  IntOp $5 $5 / 2
  IntOp $3 $3 + $5
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r2, i r3, i r6, i r7, i 0x0014)i.r0'
  !insertmacro InstallerSetupScale $0 54
  IntOp $InstallerSetupPageHeight $InstallerSetupHeight - $0
  System::Call 'user32::SetWindowPos(p $InstallerSetupPage, p 1, i 0, i 0, i $InstallerSetupWidth, i $InstallerSetupPageHeight, i 0x0010)i.r0'
  SetCtlColors $HWNDPARENT "23232A" "${INSTALLER_BACKGROUND}"
  SetCtlColors $InstallerSetupPage "23232A" "${INSTALLER_BACKGROUND}"
  StrCpy $InstallerSetupCompact "0"
  StrCpy $InstallerSetupMinimal "0"
  !insertmacro InstallerSetupScale $0 500
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
  !insertmacro InstallerSetupScale $0 28
  !insertmacro InstallerSetupScale $1 48
  !insertmacro InstallerSetupScale $2 64
  ${If} $InstallerSetupCompact == "1"
    !insertmacro InstallerSetupScale $1 24
    !insertmacro InstallerSetupScale $2 48
  ${EndIf}
  ${If} $InstallerSetupMinimal != "1"
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5400020E, i r0, i r1, i r2, i r2, p $InstallerSetupPage, p 0, p 0, p 0)p.s'
    Pop $InstallerSetupLogo
    InitPluginsDir
    ${If} $InstallerSetupDpi >= 168
      File /oname=$PLUGINSDIR\setup-brand.bmp "${INSTALLER_ANIMATION_DIR}\brand-200.bmp"
    ${ElseIf} $InstallerSetupDpi >= 120
      File /oname=$PLUGINSDIR\setup-brand.bmp "${INSTALLER_ANIMATION_DIR}\brand-150.bmp"
    ${Else}
      File /oname=$PLUGINSDIR\setup-brand.bmp "${INSTALLER_ANIMATION_DIR}\brand-100.bmp"
    ${EndIf}
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\setup-brand.bmp", i 0, i r2, i r2, i 0x2010)p.s'
    Pop $InstallerSetupBitmap
    SendMessage $InstallerSetupLogo 0x0172 0 $InstallerSetupBitmap
    !insertmacro InstallerSetupScale $3 20
    IntOp $0 $0 + $2
    IntOp $0 $0 + $3
  ${Else}
    !insertmacro InstallerSetupScale $1 14
  ${EndIf}
  !insertmacro InstallerSetupScale $2 28
  IntOp $2 $InstallerSetupWidth - $2
  IntOp $2 $2 - $0
  !insertmacro InstallerSetupScale $3 36
  System::Call 'user32::GetWindowTextW(p $mui.Header.Text, w .r4, i ${NSIS_MAX_STRLEN})i.r9'
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w r4, i 0x54000000, i r0, i r1, i r2, i r3, p $InstallerSetupPage, p 0, p 0, p 0)p.s'
  Pop $InstallerSetupHeading
  ${If} $InstallerSetupTitleFont != "0"
    SendMessage $InstallerSetupHeading ${INSTALLER_WM_SETFONT} $InstallerSetupTitleFont 0
  ${Else}
    SendMessage $InstallerSetupHeading ${INSTALLER_WM_SETFONT} $InstallerSetupBodyFont 0
  ${EndIf}
  SetCtlColors $InstallerSetupHeading "23232A" "${INSTALLER_BACKGROUND}"
  IntOp $1 $1 + $3
  !insertmacro InstallerSetupScale $3 40
  ${If} $InstallerSetupMinimal != "1"
    System::Call 'user32::GetWindowTextW(p $mui.Header.SubText, w .r4, i ${NSIS_MAX_STRLEN})i.r9'
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w r4, i 0x54000000, i r0, i r1, i r2, i r3, p $InstallerSetupPage, p 0, p 0, p 0)p.s'
    Pop $InstallerSetupSubheading
    !insertmacro InstallerSetupFont $InstallerSetupSubheading
  ${EndIf}

  !insertmacro InstallerSetupScale $0 52
  IntOp $1 $InstallerSetupHeight - $0
  !insertmacro InstallerSetupScale $2 112
  !insertmacro InstallerSetupScale $3 36
  !insertmacro InstallerSetupScale $4 28
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

!ifndef INSTALL_MODE_PER_ALL_USERS
Function InstallerSetupModeShow
  !insertmacro InstallerSetupSave
  StrCpy $InstallerSetupPage $MultiUser.InstallModePage
  Call InstallerSetupPrepare
  !insertmacro InstallerSetupScale $0 28
  IntOp $2 $0 * 2
  IntOp $2 $InstallerSetupWidth - $2
  !insertmacro InstallerSetupScale $1 176
  !insertmacro InstallerSetupScale $3 48
  !insertmacro InstallerSetupScale $4 254
  !insertmacro InstallerSetupScale $5 320
  !insertmacro InstallerSetupScale $6 404
  ${If} $InstallerSetupCompact == "1"
    !insertmacro InstallerSetupScale $1 116
    !insertmacro InstallerSetupScale $4 196
    !insertmacro InstallerSetupScale $5 248
    !insertmacro InstallerSetupScale $6 308
    !insertmacro InstallerSetupScale $3 36
  ${EndIf}
  ${If} $InstallerSetupMinimal == "1"
    ShowWindow $MultiUser.InstallModePage.Text 0
    !insertmacro InstallerSetupScale $4 60
    !insertmacro InstallerSetupScale $7 124
    ${If} $InstallerSetupPageHeight < $7
      ShowWindow $InstallerSetupHeading 0
      !insertmacro InstallerSetupScale $4 12
    ${EndIf}
    !insertmacro InstallerSetupScale $3 32
    !insertmacro InstallerSetupScale $7 12
    !insertmacro InstallerSetupScale $8 8
    IntOp $5 $InstallerSetupPageHeight - $4
    IntOp $5 $5 - $7
    IntOp $5 $5 - $8
    IntOp $5 $5 / 2
    ${If} $3 > $5
      StrCpy $3 $5
    ${EndIf}
    IntOp $5 $4 + $3
    IntOp $5 $5 + $8
    IntOp $6 $5 + $3
    IntOp $6 $6 + $7
  ${Else}
    !insertmacro InstallerSetupMove $MultiUser.InstallModePage.Text $0 $1 $2 $3
    !insertmacro InstallerSetupFont $MultiUser.InstallModePage.Text
  ${EndIf}
  !insertmacro InstallerSetupMove $MultiUser.InstallModePage.CurrentUser $0 $4 $2 $3
  !insertmacro InstallerSetupMove $MultiUser.InstallModePage.AllUsers $0 $5 $2 $3
  !insertmacro InstallerSetupFont $MultiUser.InstallModePage.CurrentUser
  !insertmacro InstallerSetupFont $MultiUser.InstallModePage.AllUsers
  !insertmacro InstallerSetupScale $1 20
  IntOp $1 $InstallerSetupPageHeight - $1
  IntOp $1 $1 - $6
  !insertmacro InstallerSetupScale $3 90
  ${If} $1 > $3
    StrCpy $1 $3
  ${EndIf}
  ${If} $1 < 0
    StrCpy $1 0
  ${EndIf}
  !insertmacro InstallerSetupMove $RadioButtonLabel1 $0 $6 $2 $1
  !insertmacro InstallerSetupFont $RadioButtonLabel1
  !insertmacro InstallerSetupScale $3 32
  ${If} $1 < $3
    ShowWindow $RadioButtonLabel1 0
  ${EndIf}
  ; Restore the native mode-change presentation after returning from a skinned
  ; directory page. This keeps its live elevation shield and permission hints.
  ${If} $HasTwoAvailableOptions == "1"
    SendMessage $MultiUser.InstallModePage.AllUsers ${BM_GETCHECK} 0 0 $0
    ${If} $0 == ${BST_CHECKED}
      Push $MultiUser.InstallModePage.AllUsers
    ${Else}
      Push $MultiUser.InstallModePage.CurrentUser
    ${EndIf}
    Call InstModeChange
  ${EndIf}
  Call InstallerSetupReveal
  !insertmacro InstallerSetupRestore
FunctionEnd
!endif

Function InstallerSetupDirectoryShow
  !insertmacro InstallerSetupSave
  StrCpy $InstallerSetupPage $mui.DirectoryPage
  Call InstallerSetupPrepare
  !insertmacro InstallerSetupScale $0 28
  IntOp $2 $0 * 2
  IntOp $2 $InstallerSetupWidth - $2
  !insertmacro InstallerSetupScale $1 176
  !insertmacro InstallerSetupScale $3 64
  ${If} $InstallerSetupCompact == "1"
    !insertmacro InstallerSetupScale $1 116
    !insertmacro InstallerSetupScale $3 52
  ${EndIf}
  !insertmacro InstallerSetupMove $mui.DirectoryPage.Text $0 $1 $2 $3
  !insertmacro InstallerSetupFont $mui.DirectoryPage.Text
  ${If} $InstallerSetupMinimal == "1"
    ShowWindow $mui.DirectoryPage.Text 0
  ${EndIf}
  ShowWindow $mui.DirectoryPage.DirectoryBox 0
  System::Call 'user32::GetWindowTextW(p $mui.DirectoryPage.DirectoryBox, w .r4, i ${NSIS_MAX_STRLEN})i.r9'
  !insertmacro InstallerSetupScale $1 260
  ${If} $InstallerSetupCompact == "1"
    !insertmacro InstallerSetupScale $1 202
  ${EndIf}
  ${If} $InstallerSetupMinimal == "1"
    !insertmacro InstallerSetupScale $1 80
    IntOp $1 $InstallerSetupPageHeight - $1
    !insertmacro InstallerSetupScale $3 60
    ${If} $1 < $3
      ShowWindow $InstallerSetupHeading 0
      !insertmacro InstallerSetupScale $1 12
    ${EndIf}
  ${EndIf}
  !insertmacro InstallerSetupScale $3 24
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w r4, i 0x54000000, i r0, i r1, i r2, i r3, p $InstallerSetupPage, p 0, p 0, p 0)p.s'
  Pop $InstallerSetupFieldLabel
  !insertmacro InstallerSetupFont $InstallerSetupFieldLabel
  !insertmacro InstallerSetupScale $3 36
  !insertmacro InstallerSetupScale $4 36
  IntOp $1 $1 + $4
  !insertmacro InstallerSetupScale $4 92
  ${If} $InstallerSetupPageHeight < $4
    ShowWindow $InstallerSetupFieldLabel 0
    !insertmacro InstallerSetupScale $1 12
  ${EndIf}
  !insertmacro InstallerSetupScale $4 112
  !insertmacro InstallerSetupScale $5 12
  IntOp $6 $2 - $4
  IntOp $6 $6 - $5
  !insertmacro InstallerSetupMove $mui.DirectoryPage.Directory $0 $1 $6 $3
  !insertmacro InstallerSetupFont $mui.DirectoryPage.Directory
  SetCtlColors $mui.DirectoryPage.Directory "475569" "F3F4F8"
  !insertmacro InstallerSetupScale $7 10
  IntOp $8 $7 << 16
  IntOp $8 $8 | $7
  SendMessage $mui.DirectoryPage.Directory 0x00D3 3 $8
  System::Call 'user32::GetWindowLongW(p $mui.DirectoryPage.Directory, i -20)i.r7'
  IntOp $7 $7 & 0xFFFFFDFF
  System::Call 'user32::SetWindowLongW(p $mui.DirectoryPage.Directory, i -20, i r7)i.r9'
  System::Call 'user32::SetWindowPos(p $mui.DirectoryPage.Directory, p 0, i 0, i 0, i 0, i 0, i 0x0037)i.r9'
  !insertmacro InstallerSetupScale $7 12
  IntOp $8 $6 + 1
  IntOp $9 $3 + 1
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i r8, i r9, i r7, i r7)p.r8'
  ${If} $8 != 0
    System::Call 'user32::SetWindowRgn(p $mui.DirectoryPage.Directory, p r8, i 1)i.r9'
    ${If} $9 == 0
      System::Call 'gdi32::DeleteObject(p r8)i.r9'
    ${EndIf}
  ${EndIf}
  IntOp $6 $6 + $0
  IntOp $6 $6 + $5
  !insertmacro InstallerSetupMove $mui.DirectoryPage.BrowseButton $6 $1 $4 $3
  !insertmacro InstallerSetupFont $mui.DirectoryPage.BrowseButton
  StrCpy $InstallerSetupBrowseControl $mui.DirectoryPage.BrowseButton
  !insertmacro InstallerPaintButton $mui.DirectoryPage.BrowseButton $InstallerSetupBodyFont $InstallerSetupDpi "${INSTALLER_BUTTON_SECONDARY}" $InstallerSetupBrowseImage
  !insertmacro InstallerSetupScale $4 24
  IntOp $1 $1 + $3
  IntOp $1 $1 + $4
  !insertmacro InstallerSetupScale $3 22
  !insertmacro InstallerSetupMove $mui.DirectoryPage.SpaceRequired $0 $1 $2 $3
  !insertmacro InstallerSetupFont $mui.DirectoryPage.SpaceRequired
  IntOp $1 $1 + $3
  !insertmacro InstallerSetupMove $mui.DirectoryPage.SpaceAvailable $0 $1 $2 $3
  !insertmacro InstallerSetupFont $mui.DirectoryPage.SpaceAvailable
  !insertmacro InstallerSetupScale $3 200
  ${If} $InstallerSetupPageHeight < $3
    ShowWindow $mui.DirectoryPage.SpaceRequired 0
    ShowWindow $mui.DirectoryPage.SpaceAvailable 0
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1
  !insertmacro InstallerPaintButton $0 $InstallerSetupBodyFont $InstallerSetupDpi "${INSTALLER_BUTTON_PRIMARY}" $InstallerSetupNextImage
  Call InstallerSetupReveal
  !insertmacro InstallerSetupRestore
FunctionEnd

!endif
