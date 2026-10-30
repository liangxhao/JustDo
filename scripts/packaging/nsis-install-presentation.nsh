!ifndef INSTALLER_PRESENTATION_INCLUDED
!define INSTALLER_PRESENTATION_INCLUDED

!include "${PROJECT_DIR}\scripts\packaging\nsis-presentation-state.nsh"
!define INSTALLER_ACM_OPENW 0x0467
!define INSTALLER_ACM_PLAY 0x0465
!define INSTALLER_ACM_STOP 0x0466
!define INSTALLER_WM_SETFONT 0x0030
!define INSTALLER_BACKGROUND "FBFBFD"
!define INSTALLER_STEP_PENDING_BG "F0F2F7"
!define INSTALLER_STEP_ACTIVE_BG "EBEDFF"
!define INSTALLER_STEP_DONE_BG "EAF5EE"
!define INSTALLER_STEP_FAILED_BG "FFF0F1"

!include "${PROJECT_DIR}\scripts\packaging\nsis-presentation-controls.nsh"

Var InstallerScene
Var InstallerFallback
Var InstallerBitmap
Var InstallerTitle
Var InstallerSubtitle
Var InstallerExplanation
Var InstallerElapsed
Var InstallerStepCheck
Var InstallerStepWrite
Var InstallerStepDone
Var InstallerTitleFont
Var InstallerBaseFont
Var InstallerOriginalFont
Var InstallerBaseFontOwned
Var InstallerLogFont
Var InstallerNextButtonImage
Var InstallerCancelButtonImage
Var InstallerDetailsButtonImage
Var InstallerLogSpacingImages
Var InstallerLogLayoutTop
Var InstallerLogLayoutHeight
Var InstallerDpi
Var InstallerWidth
Var InstallerHeight
Var InstallerSceneHeight
Var InstallerStatusTop
Var InstallerCompactLayout
Var InstallerMinimalLayout
Var InstallerWorkLeft
Var InstallerWorkTop
Var InstallerWorkWidth
Var InstallerWorkHeight
Var InstallerAnimationStarted
Var InstallerLoopStarted
Var InstallerPresentationStarted
Var InstallerElapsedSecond
Var InstallerPresentationReady
Var InstallerClockActive

!include "${PROJECT_DIR}\scripts\packaging\nsis-presentation-window.nsh"
!include "${PROJECT_DIR}\scripts\packaging\nsis-presentation-motion.nsh"

!macro InstallerScale _OUTPUT _VALUE
  IntOp ${_OUTPUT} ${_VALUE} * $InstallerDpi
  IntOp ${_OUTPUT} ${_OUTPUT} / 96
!macroend

!macro InstallerText _HANDLE _ZH _EN
  ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
  ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
    SendMessage ${_HANDLE} ${JUSTDO_WM_SETTEXT} 0 'STR:${_ZH}'
  ${Else}
    SendMessage ${_HANDLE} ${JUSTDO_WM_SETTEXT} 0 'STR:${_EN}'
  ${EndIf}
!macroend

!macro InstallerCreateText _HANDLE _X _Y _WIDTH _HEIGHT _STYLE
  !define /math INSTALLER_TEXT_STYLE ${_STYLE} | 0x04000000
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i ${INSTALLER_TEXT_STYLE}, i ${_X}, i ${_Y}, i ${_WIDTH}, i ${_HEIGHT}, p $JustDoInstFilesPage, p 0, p 0, p 0)p.s'
  !undef INSTALLER_TEXT_STYLE
  Pop ${_HANDLE}
  SendMessage ${_HANDLE} ${INSTALLER_WM_SETFONT} $InstallerBaseFont 0
  SetCtlColors ${_HANDLE} "74747E" "${INSTALLER_BACKGROUND}"
!macroend

; Passive footer capsules retain their accessible native text. The window owns
; an assigned round region; no bitmap, interaction state or extra font is owned.
!macro InstallerCreateFooterStep _HANDLE _X _Y _WIDTH _HEIGHT
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x54004281, i ${_X}, i ${_Y}, i ${_WIDTH}, i ${_HEIGHT}, p $HWNDPARENT, p 0, p 0, p 0)p.s'
  Pop ${_HANDLE}
  SendMessage ${_HANDLE} ${INSTALLER_WM_SETFONT} $InstallerBaseFont 0
  IntOp $R7 ${_WIDTH} + 1
  IntOp $R8 ${_HEIGHT} + 1
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i $R7, i $R8, i ${_HEIGHT}, i ${_HEIGHT})p.s'
  Pop $R6
  ${If} $R6 != 0
    System::Call 'user32::SetWindowRgn(p ${_HANDLE}, p $R6, i 0)i.s'
    Pop $R9
    ${If} $R9 == 0
      System::Call 'gdi32::DeleteObject(p $R6)i.s'
      Pop $R9
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
!macroend

; These macros are also consumed by the independent shell-extraction helper.
; They run only on the install section's worker; no script timer re-enters NSIS.
; The separate native clock also advances during synchronous worker operations.
!macro InstallerPresentationPoll
  Call InstallerPresentationTick
!macroend

!macro InstallerPresentationShellStart
  Push "${INSTALLER_STAGE_SHELL}"
  Call InstallerPresentationSetStage
!macroend

; Let an expanded native log use the idle action row while setup is working.
; Only actual terminal states reserve space for their visible result buttons.
Function InstallerLayoutDetails
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $R9
  StrCpy $R9 "0"
  ${If} ${Errors}
    StrCpy $R9 "1"
  ${EndIf}
  ${If} $InstallerPresentationReady != "1"
  ${OrIf} $InstallerLogLayoutTop == ""
  ${OrIf} $JustDoInstallLog == ""
  ${OrIf} $JustDoInstallLog == "0"
    Goto InstallerDetailsLayoutDone
  ${EndIf}
  !insertmacro InstallerScale $0 40
  ${If} $InstallerPresentationStage == "${INSTALLER_STAGE_COMPLETE}"
  ${OrIf} $InstallerPresentationStage == "${INSTALLER_STAGE_FAILED}"
    !insertmacro InstallerScale $0 90
  ${EndIf}
  IntOp $0 $InstallerHeight - $0
  IntOp $0 $0 - $InstallerLogLayoutTop
  ${If} $0 < 0
    StrCpy $0 0
  ${EndIf}
  ${If} $InstallerLogLayoutHeight == $0
    Goto InstallerDetailsLayoutDone
  ${EndIf}
  !insertmacro InstallerScale $1 28
  IntOp $2 $1 * 2
  IntOp $2 $InstallerWidth - $2
  ; A prior smaller round region would clip the newly available lower rows.
  ; Removing it also leaves a full rectangular fallback if rounding fails.
  System::Call 'user32::SetWindowRgn(p $JustDoInstallLog, p 0, i 0)i.r3'
  System::Call 'user32::SetWindowPos(p $JustDoInstallLog, p 0, i r1, i $InstallerLogLayoutTop, i r2, i r0, i 0x0014)i.r3'
  ${If} $3 == 0
    Goto InstallerDetailsLayoutDone
  ${EndIf}
  StrCpy $InstallerLogLayoutHeight $0
  !insertmacro InstallerScale $3 16
  IntOp $4 $2 + 1
  IntOp $5 $0 + 1
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i r4, i r5, i r3, i r3)p.r4'
  ${If} $4 != 0
    System::Call 'user32::SetWindowRgn(p $JustDoInstallLog, p r4, i 1)i.r1'
    ${If} $1 == 0
      System::Call 'gdi32::DeleteObject(p r4)i.r1'
    ${EndIf}
  ${EndIf}
  System::Call 'user32::InvalidateRect(p $JustDoInstallLog, p 0, i 1)i.r1'
  InstallerDetailsLayoutDone:
  ${If} $R9 == "1"
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $R9
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function InstallerPositionResultButtons
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  !insertmacro InstallerScale $1 28
  !insertmacro InstallerScale $2 112
  !insertmacro InstallerScale $3 12
  IntOp $4 $2 * 2
  IntOp $4 $4 + $3
  IntOp $5 $1 * 2
  IntOp $4 $4 + $5
  ${If} $InstallerWidth < $4
    IntOp $2 $InstallerWidth - $5
    IntOp $2 $2 - $3
    IntOp $2 $2 / 2
  ${EndIf}
  IntOp $4 $InstallerWidth - $1
  IntOp $4 $4 - $2
  !insertmacro InstallerScale $1 80
  IntOp $1 $InstallerHeight - $1
  !insertmacro InstallerScale $5 36
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'user32::SetWindowPos(p r0, p 0, i r4, i r1, i r2, i r5, i 0x0010)i.r0'
  ${If} $InstallerPresentationStage == "${INSTALLER_STAGE_COMPLETE}"
    IntOp $4 $4 - $3
    IntOp $4 $4 - $2
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 2
  System::Call 'user32::SetWindowPos(p r0, p 0, i r4, i r1, i r2, i r5, i 0x0010)i.r0'
  ; Keep the native details command clear of both terminal actions on narrow
  ; high-DPI work areas. Do not re-show a link hidden by NSIS after expansion.
  !insertmacro InstallerScale $2 28
  IntOp $4 $4 - $3
  IntOp $4 $4 - $2
  !insertmacro InstallerScale $5 160
  ${If} $5 > $4
    StrCpy $5 $4
    !insertmacro InstallerText $JustDoShowLogButton "详情" "Details"
  ${Else}
    !insertmacro InstallerText $JustDoShowLogButton "查看安装详情" "Installation details"
  ${EndIf}
  ${If} $5 < 0
    StrCpy $5 0
  ${EndIf}
  !insertmacro InstallerScale $3 25
  System::Call 'user32::SetWindowPos(p $JustDoShowLogButton, p 0, i r2, i r1, i r5, i r3, i 0x0004)i.r0'
  !insertmacro InstallerPaintButton $JustDoShowLogButton $InstallerBaseFont $InstallerDpi "${INSTALLER_BUTTON_LINK}" $InstallerDetailsButtonImage
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function InstallerPresentationTick
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $R9
  StrCpy $R9 "0"
  ${If} ${Errors}
    StrCpy $R9 "1"
  ${EndIf}
  ${If} $InstallerPresentationReady != "1"
    Goto InstallerTickDone
  ${EndIf}
  ${If} $InstallerPresentationStage == "${INSTALLER_STAGE_COMPLETE}"
  ${OrIf} $InstallerPresentationStage == "${INSTALLER_STAGE_FAILED}"
    Goto InstallerTickDone
  ${EndIf}
  System::Call 'kernel32::GetTickCount()i.r0'
  ${If} $InstallerScene != "0"
  ${AndIf} $InstallerLoopStarted != "1"
    IntOp $1 $0 - $InstallerAnimationStarted
    ${If} $1 >= 1500
      ; If a previous synchronous native step delayed the first poll, the full
      ; clip kept playing. Subsequent playback uses only the seamless loop.
      IntOp $1 ${INSTALLER_ANIMATION_LAST_FRAME} << 16
      IntOp $1 $1 | ${INSTALLER_ANIMATION_LOOP_FIRST}
      SendMessage $InstallerScene ${INSTALLER_ACM_PLAY} -1 $1
      StrCpy $InstallerLoopStarted "1"
    ${EndIf}
  ${EndIf}
  IntOp $1 $0 - $InstallerPresentationStarted
  IntOp $1 $1 / 1000
  ${If} $InstallerClockActive != "1"
  ${AndIf} $1 != $InstallerElapsedSecond
    StrCpy $InstallerElapsedSecond $1
    IntOp $2 $1 / 60
    IntOp $3 $1 % 60
    IntFmt $2 "%02u" $2
    IntFmt $3 "%02u" $3
    !insertmacro InstallerText $InstallerElapsed "已用时 $2:$3" "Elapsed $2:$3"
  ${EndIf}
  InstallerTickDone:
  ${If} $R9 == "1"
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $R9
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function InstallerPresentationSetStage
  Exch $0
  Push $1
  Push $R9
  StrCpy $R9 "0"
  ${If} ${Errors}
    StrCpy $R9 "1"
  ${EndIf}
  StrCpy $InstallerPresentationStage "$0"
  ${If} $InstallerPresentationReady != "1"
    Goto InstallerStageDone
  ${EndIf}
  Call InstallerLayoutDetails
  ${If} $0 == "${INSTALLER_STAGE_COMPLETE}"
  ${OrIf} $0 == "${INSTALLER_STAGE_FAILED}"
    ${If} $InstallerClockActive == "1"
      System::Call '$PLUGINSDIR\installer-clock.dll::Stop(p $InstallerElapsed)i.r1'
    ${EndIf}
  ${EndIf}
  SetCtlColors $InstallerStepCheck "64748B" "${INSTALLER_STEP_PENDING_BG}"
  SetCtlColors $InstallerStepWrite "64748B" "${INSTALLER_STEP_PENDING_BG}"
  SetCtlColors $InstallerStepDone "64748B" "${INSTALLER_STEP_PENDING_BG}"
  ${If} $0 == "${INSTALLER_STAGE_CHECKING}"
    !insertmacro InstallerText $InstallerStepCheck "● 检查占用" "● Check location"
    SetCtlColors $InstallerStepCheck "4F58C9" "${INSTALLER_STEP_ACTIVE_BG}"
    !insertmacro InstallerText $InstallerExplanation "仅检查所选安装目录中的占用情况。" "Checking processes and file locks in the selected installation location."
  ${Else}
    !insertmacro InstallerText $InstallerStepCheck "✓ 检查占用" "✓ Check location"
    !insertmacro InstallerText $InstallerStepWrite "● 写入文件" "● Write files"
    SetCtlColors $InstallerStepCheck "287A61" "${INSTALLER_STEP_DONE_BG}"
    SetCtlColors $InstallerStepWrite "4F58C9" "${INSTALLER_STEP_ACTIVE_BG}"
    !insertmacro InstallerText $InstallerExplanation "将应用与随包组件解压到所选安装目录。" "Writing the application and bundled components to the selected location."
  ${EndIf}
  ${If} $0 == "${INSTALLER_STAGE_RESOURCES}"
    !insertmacro InstallerText $InstallerExplanation "文件较多时可能需要一点时间，请保持安装器打开。" "With many files, this step can take a little time. Keep setup open."
  ${ElseIf} $0 == "${INSTALLER_STAGE_FINALIZING}"
    !insertmacro InstallerText $InstallerExplanation "正在完成安装文件的检查和收尾。" "Checking the installed files and finishing setup."
  ${ElseIf} $0 == "${INSTALLER_STAGE_COMPLETE}"
    ${If} $InstallerScene != "0"
      SendMessage $InstallerScene ${INSTALLER_ACM_STOP} 0 0
      SendMessage $InstallerScene ${INSTALLER_ACM_PLAY} 1 ${INSTALLER_ANIMATION_COMPLETE_FRAME}
    ${EndIf}
    !insertmacro InstallerText $InstallerTitle "安装完成" "Installation complete"
    !insertmacro JustDoSetInstallStatus "安装完成。" "Installation complete."
    SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETPOS} 100 0
    !insertmacro InstallerText $InstallerSubtitle "应用文件已安装到所选目录。" "The application files are installed in your selected location."
    !insertmacro InstallerText $InstallerExplanation "点击“打开应用”立即使用，或关闭安装器稍后打开。" "Open the application now, or close setup and open it later."
    !insertmacro InstallerText $InstallerStepCheck "✓ 检查完成" "✓ Checked"
    !insertmacro InstallerText $InstallerStepWrite "✓ 写入完成" "✓ Files written"
    !insertmacro InstallerText $InstallerStepDone "✓ 安装完成" "✓ Complete"
    SetCtlColors $InstallerStepCheck "287A61" "${INSTALLER_STEP_DONE_BG}"
    SetCtlColors $InstallerStepWrite "287A61" "${INSTALLER_STEP_DONE_BG}"
    SetCtlColors $InstallerStepDone "287A61" "${INSTALLER_STEP_DONE_BG}"
    Call InstallerPositionResultButtons
    GetDlgItem $1 $HWNDPARENT 2
    !insertmacro InstallerText $1 "关闭" "Close"
    !insertmacro InstallerPaintButton $1 $InstallerBaseFont $InstallerDpi "${INSTALLER_BUTTON_SECONDARY}" $InstallerCancelButtonImage
    ShowWindow $1 5
    GetDlgItem $1 $HWNDPARENT 1
    !insertmacro InstallerText $1 "打开应用" "Open app"
    !insertmacro InstallerPaintButton $1 $InstallerBaseFont $InstallerDpi "${INSTALLER_BUTTON_PRIMARY}" $InstallerNextButtonImage
    ShowWindow $1 5
  ${ElseIf} $0 == "${INSTALLER_STAGE_FAILED}"
    StrCpy $InstallerOpenOnFinish "0"
    ${If} $InstallerScene != "0"
      SendMessage $InstallerScene ${INSTALLER_ACM_STOP} 0 0
    ${EndIf}
    !insertmacro InstallerText $InstallerTitle "安装未完成" "Installation did not complete"
    !insertmacro JustDoSetInstallStatus "安装未完成，请查看安装详情。" "Installation did not complete. See the details."
    !insertmacro InstallerText $InstallerSubtitle "文件写入遇到问题，请查看安装详情。" "Setup encountered a file error. See the installation details."
    !insertmacro InstallerText $InstallerStepWrite "! 写入文件" "! Write files"
    SetCtlColors $InstallerStepWrite "B75663" "${INSTALLER_STEP_FAILED_BG}"
    Call InstallerPositionResultButtons
    GetDlgItem $1 $HWNDPARENT 2
    ; NSIS restores its localized Cancel caption after an aborted worker.
    ; Render that same caption so image and native accessible name agree.
    SendMessage $1 ${JUSTDO_WM_SETTEXT} 0 'STR:$(^CancelBtn)'
    !insertmacro InstallerPaintButton $1 $InstallerBaseFont $InstallerDpi "${INSTALLER_BUTTON_PRIMARY}" $InstallerCancelButtonImage
    ShowWindow $1 5
  ${EndIf}
  InstallerStageDone:
  ; SetCtlColors updates metadata without invalidating the native surface.
  ; Refresh after the final palette, rather than depending on a text repaint.
  !macro InstallerRefreshFooterStep _HANDLE
    ${If} ${_HANDLE} != ""
    ${AndIf} ${_HANDLE} != "0"
      System::Call 'user32::InvalidateRect(p ${_HANDLE}, p 0, i 1)i.r1'
    ${EndIf}
  !macroend
  !insertmacro InstallerRefreshFooterStep $InstallerStepCheck
  !insertmacro InstallerRefreshFooterStep $InstallerStepWrite
  !insertmacro InstallerRefreshFooterStep $InstallerStepDone
  Call InstallerPresentationTick
  ${If} $R9 == "1"
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $R9
  Pop $1
  Pop $0
FunctionEnd

; NSIS invokes the instfiles LEAVE callback when the worker finishes, while the
; result page is still visible. .onInstFailed alone runs too late (on close).
; This also covers native/upstream failures outside our extraction helpers.
Function InstallerPresentationLeave
  IfAbort InstallerPresentationAborted
  Push "${INSTALLER_STAGE_COMPLETE}"
  Call InstallerPresentationSetStage
  StrCpy $InstallerOpenOnFinish "0"
  ; NSIS relabels both result buttons and disables Cancel after LEAVE. Restore
  ; their actions after its UI handler returns, without re-entering the VM.
  Push $0
  Push $1
  Push $2
  Push $3
  GetDlgItem $0 $HWNDPARENT 1
  GetDlgItem $1 $HWNDPARENT 2
  ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
  ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
    StrCpy $2 "打开应用"
    StrCpy $3 "关闭"
  ${Else}
    StrCpy $2 "Open app"
    StrCpy $3 "Close"
  ${EndIf}
  System::Call '$PLUGINSDIR\installer-clock.dll::CompleteActions(p r0, w r2, p r1, w r3)i.r0'
  ${If} $0 == "1"
    StrCpy $InstallerOpenOnFinish "1"
  ${Else}
    ; If Windows could not prepare both actions, retain the native Close-only
    ; result rather than letting its Close command open the application.
    GetDlgItem $0 $HWNDPARENT 1
    !insertmacro InstallerText $0 "关闭" "Close"
    !insertmacro InstallerPaintButton $0 $InstallerBaseFont $InstallerDpi "${INSTALLER_BUTTON_PRIMARY}" $InstallerNextButtonImage
    GetDlgItem $0 $HWNDPARENT 2
    ShowWindow $0 0
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Return
  InstallerPresentationAborted:
  Push "${INSTALLER_STAGE_FAILED}"
  Call InstallerPresentationSetStage
FunctionEnd

Function InstallerPresentationDestroy
  Push $0
  ${If} $InstallerPresentationReady == "1"
    ${If} $InstallerClockActive == "1"
      System::Call '$PLUGINSDIR\installer-clock.dll::Destroy(p $InstallerElapsed)i.r0'
      StrCpy $InstallerClockActive "0"
    ${EndIf}
    GetDlgItem $0 $HWNDPARENT 1
    !insertmacro InstallerReleaseButton $0 $InstallerNextButtonImage
    GetDlgItem $0 $HWNDPARENT 2
    !insertmacro InstallerReleaseButton $0 $InstallerCancelButtonImage
    !insertmacro InstallerReleaseButton $JustDoShowLogButton $InstallerDetailsButtonImage
    ${If} $InstallerLogSpacingImages != "0"
      SendMessage $JustDoInstallLog 0x1002 1 0 $0
      ${If} $0 == $InstallerLogSpacingImages
        SendMessage $JustDoInstallLog 0x1003 1 0
      ${EndIf}
      System::Call 'comctl32::ImageList_Destroy(p $InstallerLogSpacingImages)i.r0'
      StrCpy $InstallerLogSpacingImages "0"
    ${EndIf}
    !macro InstallerDestroyText _HANDLE
      ${If} ${_HANDLE} != "0"
        System::Call 'user32::DestroyWindow(p ${_HANDLE})i.r0'
        StrCpy ${_HANDLE} "0"
      ${EndIf}
    !macroend
    !insertmacro InstallerDestroyText $InstallerSubtitle
    !insertmacro InstallerDestroyText $JustDoStatusText
    !insertmacro InstallerDestroyText $InstallerExplanation
    !insertmacro InstallerDestroyText $InstallerElapsed
    !insertmacro InstallerDestroyText $InstallerStepCheck
    !insertmacro InstallerDestroyText $InstallerStepWrite
    !insertmacro InstallerDestroyText $InstallerStepDone
    !insertmacro InstallerDestroyText $JustDoNativeProgressBar
    SendMessage $JustDoShowLogButton ${INSTALLER_WM_SETFONT} $InstallerOriginalFont 0
    SendMessage $JustDoInstallLog ${INSTALLER_WM_SETFONT} $InstallerOriginalFont 0
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${INSTALLER_WM_SETFONT} $InstallerOriginalFont 0
    GetDlgItem $0 $HWNDPARENT 2
    SendMessage $0 ${INSTALLER_WM_SETFONT} $InstallerOriginalFont 0
  ${EndIf}
  ${If} $InstallerScene != ""
  ${AndIf} $InstallerScene != "0"
    SendMessage $InstallerScene ${INSTALLER_ACM_STOP} 0 0
    SendMessage $InstallerScene ${INSTALLER_ACM_OPENW} 0 0
    System::Call 'user32::DestroyWindow(p $InstallerScene)i.r0'
  ${EndIf}
  ${If} $InstallerFallback != ""
  ${AndIf} $InstallerFallback != "0"
    SendMessage $InstallerFallback 0x0172 0 0
    System::Call 'user32::DestroyWindow(p $InstallerFallback)i.r0'
  ${EndIf}
  ${If} $InstallerBitmap != ""
  ${AndIf} $InstallerBitmap != "0"
    System::Call 'gdi32::DeleteObject(p $InstallerBitmap)i.r0'
  ${EndIf}
  ${If} $InstallerLogFont != ""
  ${AndIf} $InstallerLogFont != "0"
    System::Call 'gdi32::DeleteObject(p $InstallerLogFont)i.r0'
    StrCpy $InstallerLogFont "0"
  ${EndIf}
  ; The title is the only owner of its derived font. Remove it before freeing.
  ${If} $InstallerTitle != ""
  ${AndIf} $InstallerTitle != "0"
    System::Call 'user32::DestroyWindow(p $InstallerTitle)i.r0'
  ${EndIf}
  ${If} $InstallerTitleFont != ""
  ${AndIf} $InstallerTitleFont != "0"
    System::Call 'gdi32::DeleteObject(p $InstallerTitleFont)i.r0'
  ${EndIf}
  ${If} $InstallerBaseFontOwned == "1"
    System::Call 'gdi32::DeleteObject(p $InstallerBaseFont)i.r0'
    StrCpy $InstallerBaseFontOwned "0"
  ${EndIf}
  StrCpy $InstallerScene "0"
  StrCpy $InstallerFallback "0"
  StrCpy $InstallerNextButtonImage "0"
  StrCpy $InstallerCancelButtonImage "0"
  StrCpy $InstallerDetailsButtonImage "0"
  StrCpy $InstallerBitmap "0"
  StrCpy $InstallerTitle "0"
  StrCpy $InstallerTitleFont "0"
  StrCpy $InstallerLogLayoutTop "0"
  StrCpy $InstallerLogLayoutHeight "0"
  StrCpy $InstallerPresentationReady "0"
  ClearErrors
  Pop $0
FunctionEnd

Function InstallerPresentationChrome
  Push $0
  Push $1
  ; A single system Close affordance keeps the installation card compact.
  ; The native caption still provides dragging and the system menu.
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16)i.r0'
  IntOp $0 $0 & 0xFFFCFFFF
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)i.r1'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i 0, i 0, i 0x0037)i.r1'
  ; Retain real non-client dragging and the system menu. The cool-gray caption
  ; separates the window controls from the near-white content canvas.
  ; Unsupported DWM attributes are non-fatal.
  ; WTA_NONCLIENT, WTNCA_NODRAWCAPTION | WTNCA_NODRAWICON.
  System::Call '*(i 3, i 3)p.r0'
  System::Call 'uxtheme::SetWindowThemeAttribute(p $HWNDPARENT, i 1, p r0, i 8)i.r1'
  System::Free $0
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 0, i 4)i.r0'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4)i.r0'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i -2, i 4)i.r0'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0xF2E9E6, i 4)i.r0'
  Pop $1
  Pop $0
FunctionEnd

Function InstallerPresentationShow
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
  SendMessage $HWNDPARENT ${JUSTDO_WM_SETREDRAW} 0 0
  FindWindow $JustDoInstFilesPage "#32770" "" $HWNDPARENT
  GetDlgItem $JustDoInstallLog $JustDoInstFilesPage 1016
  GetDlgItem $JustDoShowLogButton $JustDoInstFilesPage 1027
  GetDlgItem $0 $JustDoInstFilesPage 1006
  SendMessage $0 0x0031 0 0 $InstallerBaseFont
  ${If} $InstallerBaseFont == "0"
    System::Call 'gdi32::GetStockObject(i 17)p.s'
    Pop $InstallerBaseFont
  ${EndIf}
  StrCpy $InstallerOriginalFont $InstallerBaseFont
  StrCpy $InstallerBaseFontOwned "0"
  StrCpy $InstallerLogFont "0"
  ShowWindow $0 0
  GetDlgItem $0 $JustDoInstFilesPage 1004
  ShowWindow $0 0
  StrCpy $JustDoProgressBar ""
  StrCpy $InstallerScene "0"
  StrCpy $InstallerBitmap "0"
  StrCpy $InstallerFallback "0"
  StrCpy $InstallerNextButtonImage "0"
  StrCpy $InstallerCancelButtonImage "0"
  StrCpy $InstallerDetailsButtonImage "0"
  StrCpy $InstallerLoopStarted "0"
  StrCpy $InstallerLogSpacingImages "0"
  StrCpy $InstallerLogLayoutTop ""
  StrCpy $InstallerLogLayoutHeight "-1"
  StrCpy $InstallerElapsedSecond "-1"
  StrCpy $InstallerClockActive "0"
  StrCpy $InstallerOpenOnFinish "0"
  Call InstallerWindowPrepare
  StrCpy $InstallerWindowPage $JustDoInstFilesPage
  ; The working log can extend through the otherwise idle action row, stopping
  ; just above the root footer capsules. Terminal states shorten only the log.
  !insertmacro InstallerScale $4 36
  IntOp $4 $InstallerHeight - $4
  System::Call 'user32::SetWindowPos(p $JustDoInstFilesPage, p 0, i 0, i 0, i $InstallerWidth, i r4, i 0x0004)i.r4'
  ; The child also hosts the native details link in the action row. Clip its
  ; background against real result buttons raised above it on completion.
  System::Call 'user32::GetWindowLongW(p $JustDoInstFilesPage, i -16)i.r0'
  IntOp $0 $0 | 0x04000000
  System::Call 'user32::SetWindowLongW(p $JustDoInstFilesPage, i -16, i r0)i.r1'
  SetCtlColors $HWNDPARENT "23232A" "${INSTALLER_BACKGROUND}"
  SetCtlColors $JustDoInstFilesPage "23232A" "${INSTALLER_BACKGROUND}"
  !insertmacro InstallerWindowDivider $JustDoInstFilesPage

  ; Hide the MUI header, separators and Back button. Account/directory pages
  ; retain their original controls; this is the final page of assisted setup.
  StrCpy $0 0
  InstallerHideChrome:
  System::Call 'user32::FindWindowExW(p $HWNDPARENT, p r0, p 0, p 0)p.r0'
  ${If} $0 != 0
    System::Call 'user32::GetDlgCtrlID(p r0)i.r1'
    ${If} $0 != $JustDoInstFilesPage
    ${AndIf} $1 != 1
    ${AndIf} $1 != 2
      ShowWindow $0 0
      ${If} $1 == 3
        ; NSIS can show its disabled Back button again after worker completion.
        ; This final page cannot navigate back; keep its real handle but remove
        ; its drawing bounds so the old setup footer cannot reappear.
        System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i 0, i 0, i 0x0016)i.r1'
      ${EndIf}
    ${EndIf}
    Goto InstallerHideChrome
  ${EndIf}

  ; These Windows UI faces are already installed with their respective locale.
  ; DEFAULT_CHARSET retains Windows font fallback; no external font is loaded.
  StrCpy $3 "Segoe UI"
  ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
  ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
    StrCpy $3 "Microsoft YaHei UI"
  ${EndIf}
  !insertmacro InstallerScale $0 14
  IntOp $0 0 - $0
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w r3)p.r1'
  ${If} $1 != 0
    StrCpy $InstallerBaseFont $1
    StrCpy $InstallerBaseFontOwned "1"
  ${EndIf}
  !insertmacro InstallerScale $0 12
  IntOp $0 0 - $0
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w r3)p.s'
  Pop $InstallerLogFont
  !insertmacro InstallerScale $0 24
  IntOp $0 0 - $0
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 500, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w r3)p.s'
  Pop $InstallerTitleFont

  !insertmacro InstallerScale $R0 28
  IntOp $R1 $R0 * 2
  IntOp $R1 $InstallerWidth - $R1
  ; R2 is the safe content height above actions; the native child extends
  ; farther down solely to retain its own details button and command routing.
  !insertmacro InstallerScale $0 84
  IntOp $R2 $InstallerHeight - $0
  ; Reserve a lower details area as well as the status and anchored steps.
  ; A clamped work area must compress the hero rather than overlap text rows.
  IntOp $InstallerStatusTop $R2 * 63
  IntOp $InstallerStatusTop $InstallerStatusTop / 100
  !insertmacro InstallerScale $0 164
  IntOp $1 $R2 - $0
  ${If} $InstallerStatusTop > $1
    StrCpy $InstallerStatusTop $1
  ${EndIf}
  ; Keep the full orbit canvas when space permits. Short screens may hide the
  ; hero, but normal layouts must not crop its rotating upper/lower light arcs.
  !insertmacro InstallerScale $InstallerSceneHeight 144
  !insertmacro InstallerScale $0 68
  IntOp $1 $InstallerStatusTop - $0
  ${If} $InstallerSceneHeight > $1
    StrCpy $InstallerSceneHeight $1
  ${EndIf}
  ${If} $InstallerSceneHeight < 144
    StrCpy $InstallerSceneHeight 144
  ${EndIf}
  StrCpy $InstallerCompactLayout "0"
  StrCpy $InstallerMinimalLayout "0"
  !insertmacro InstallerScale $0 68
  IntOp $0 $0 + $InstallerSceneHeight
  ${If} $InstallerStatusTop < $0
    StrCpy $InstallerCompactLayout "1"
    !insertmacro InstallerScale $InstallerStatusTop 14
  ${EndIf}
  ; At extreme scaling on a short display, keep the phase, clock, bar and
  ; details usable by removing secondary copy and step labels altogether.
  !insertmacro InstallerScale $0 217
  ${If} $R2 < $0
    StrCpy $InstallerMinimalLayout "1"
  ${EndIf}
  !insertmacro InstallerScale $R3 8
  System::Call '*(i 8, i 128)p.r0'
  System::Call 'comctl32::InitCommonControlsEx(p r0)i.r1'
  System::Free $0
  System::Call 'user32::CreateWindowExW(i 0, w "SysAnimate32", w "", i 0x54000003, i $R0, i $R3, i $R1, i $InstallerSceneHeight, p $JustDoInstFilesPage, p 0, p 0, p 0)p.s'
  Pop $InstallerScene
  SetCtlColors $InstallerScene "" "${INSTALLER_BACKGROUND}"
  InitPluginsDir
  ${If} $InstallerDpi >= 168
  ${AndIf} $InstallerSceneHeight >= 288
  ${AndIf} $R1 >= 360
    File /oname=$PLUGINSDIR\installer-brand.avi "${INSTALLER_ANIMATION_DIR}\brand-200.avi"
    File /oname=$PLUGINSDIR\installer-brand.bmp "${INSTALLER_ANIMATION_DIR}\brand-200.bmp"
  ${ElseIf} $InstallerDpi >= 120
  ${AndIf} $InstallerSceneHeight >= 216
  ${AndIf} $R1 >= 270
    File /oname=$PLUGINSDIR\installer-brand.avi "${INSTALLER_ANIMATION_DIR}\brand-150.avi"
    File /oname=$PLUGINSDIR\installer-brand.bmp "${INSTALLER_ANIMATION_DIR}\brand-150.bmp"
  ${Else}
    File /oname=$PLUGINSDIR\installer-brand.avi "${INSTALLER_ANIMATION_DIR}\brand-100.avi"
    File /oname=$PLUGINSDIR\installer-brand.bmp "${INSTALLER_ANIMATION_DIR}\brand-100.bmp"
  ${EndIf}
  StrCpy $0 0
  ${If} $InstallerScene != "0"
    SendMessage $InstallerScene ${INSTALLER_ACM_OPENW} 0 'STR:$PLUGINSDIR\installer-brand.avi' $0
  ${EndIf}
  ${If} $0 != 0
    IntOp $0 ${INSTALLER_ANIMATION_LAST_FRAME} << 16
    SendMessage $InstallerScene ${INSTALLER_ACM_PLAY} -1 $0
  ${Else}
    ${If} $InstallerScene != "0"
      System::Call 'user32::DestroyWindow(p $InstallerScene)i.r0'
    ${EndIf}
    StrCpy $InstallerScene "0"
    !insertmacro InstallerCreateText $InstallerFallback $R0 $R3 $R1 $InstallerSceneHeight 0x5000020E
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\installer-brand.bmp", i 0, i 0, i 0, i 0x2010)p.s'
    Pop $InstallerBitmap
    SendMessage $InstallerFallback 0x0172 0 $InstallerBitmap
  ${EndIf}
  ClearErrors
  System::Call 'kernel32::GetTickCount()i.r0'
  StrCpy $InstallerAnimationStarted $0
  StrCpy $InstallerPresentationStarted $0

  IntOp $R3 $R3 + $InstallerSceneHeight
  !insertmacro InstallerScale $0 4
  IntOp $R3 $R3 + $0
  !insertmacro InstallerScale $R4 28
  !insertmacro InstallerCreateText $InstallerTitle $R0 $R3 $R1 $R4 0x50004001
  ${If} $InstallerTitleFont != "0"
    SendMessage $InstallerTitle ${INSTALLER_WM_SETFONT} $InstallerTitleFont 0
  ${EndIf}
  SetCtlColors $InstallerTitle "23232A" "${INSTALLER_BACKGROUND}"
  !insertmacro InstallerText $InstallerTitle "正在安装 ${PRODUCT_NAME}" "Installing ${PRODUCT_NAME}"
  IntOp $R3 $R3 + $R4
  !insertmacro InstallerScale $R4 20
  !insertmacro InstallerCreateText $InstallerSubtitle $R0 $R3 $R1 $R4 0x50000001
  !insertmacro InstallerText $InstallerSubtitle "将应用文件安装到你选择的目录。" "Installing the application files in your selected location."

  StrCpy $R3 $InstallerStatusTop
  !insertmacro InstallerScale $R4 23
  IntOp $1 $R1 * 3
  IntOp $1 $1 / 4
  !insertmacro InstallerCreateText $JustDoStatusText $R0 $R3 $1 $R4 0x50000000
  SetCtlColors $JustDoStatusText "23232A" "${INSTALLER_BACKGROUND}"
  IntOp $0 $R0 + $1
  IntOp $1 $R1 / 4
  !insertmacro InstallerCreateText $InstallerElapsed $0 $R3 $1 $R4 0x50000002
  IntOp $R3 $R3 + $R4
  !insertmacro InstallerScale $R4 5
  System::Call 'user32::CreateWindowExW(i 0, w "msctls_progress32", w "", i 0x54000001, i $R0, i $R3, i $R1, i $R4, p $JustDoInstFilesPage, p 0, p 0, p 0)p.s'
  Pop $JustDoNativeProgressBar
  System::Call 'uxtheme::SetWindowTheme(p $JustDoNativeProgressBar, w " ", w " ")'
  SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETRANGE32} 0 100
  SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETBARCOLOR} 0 0xE8645F
  SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETBKCOLOR} 0 0xF0EAE9
  !insertmacro InstallerScale $0 15
  IntOp $R3 $R3 + $0
  !insertmacro InstallerScale $R4 32
  !insertmacro InstallerCreateText $InstallerExplanation $R0 $R3 $R1 $R4 0x50000000

  !insertmacro InstallerScale $0 34
  IntOp $R3 $InstallerHeight - $0
  !insertmacro InstallerScale $R4 26
  !insertmacro InstallerScale $2 12
  IntOp $1 $2 * 2
  IntOp $1 $R1 - $1
  IntOp $1 $1 / 3
  !insertmacro InstallerCreateFooterStep $InstallerStepCheck $R0 $R3 $1 $R4
  IntOp $0 $R0 + $1
  IntOp $0 $0 + $2
  !insertmacro InstallerCreateFooterStep $InstallerStepWrite $0 $R3 $1 $R4
  IntOp $0 $0 + $1
  IntOp $0 $0 + $2
  !insertmacro InstallerCreateFooterStep $InstallerStepDone $0 $R3 $1 $R4
  !insertmacro InstallerText $InstallerStepWrite "○ 写入文件" "○ Write files"
  !insertmacro InstallerText $InstallerStepDone "○ 安装完成" "○ Complete"

  ${If} $InstallerCompactLayout == "1"
    ShowWindow $InstallerScene 0
    ShowWindow $InstallerFallback 0
    ShowWindow $InstallerTitle 0
    ShowWindow $InstallerSubtitle 0
  ${EndIf}
  ${If} $InstallerMinimalLayout == "1"
    ShowWindow $InstallerExplanation 0
    ShowWindow $InstallerStepCheck 0
    ShowWindow $InstallerStepWrite 0
    ShowWindow $InstallerStepDone 0
  ${EndIf}

  ; Keep native one-way details, scrolling and keyboard behavior. Opening the
  ; list reveals the reserved area below the phase explanation, never the hero.
  !insertmacro InstallerScale $1 76
  !insertmacro InstallerScale $3 6
  ${If} $InstallerMinimalLayout == "1"
    !insertmacro InstallerScale $1 42
  ${EndIf}
  IntOp $1 $InstallerStatusTop + $1
  StrCpy $InstallerLogLayoutTop $1
  IntOp $3 $R2 - $3
  IntOp $3 $3 - $1
  ${If} $3 < 0
    StrCpy $3 0
  ${EndIf}
  System::Call 'user32::SetWindowPos(p $JustDoInstallLog, p 0, i $R0, i r1, i $R1, i r3, i 0)i.r0'
  ; Keep the native log and its scroll/keyboard behavior, with a flat surface.
  System::Call 'user32::GetWindowLongW(p $JustDoInstallLog, i -16)i.r0'
  IntOp $0 $0 & 0xFF7FFFFF
  System::Call 'user32::SetWindowLongW(p $JustDoInstallLog, i -16, i r0)i.r0'
  System::Call 'user32::GetWindowLongW(p $JustDoInstallLog, i -20)i.r0'
  IntOp $0 $0 & 0xFFFFFDFF
  System::Call 'user32::SetWindowLongW(p $JustDoInstallLog, i -20, i r0)i.r0'
  System::Call 'uxtheme::SetWindowTheme(p $JustDoInstallLog, w "Explorer", p 0)i.r0'
  ; Single-column, quiet log surface. SetCtlColors alone does not style native
  ; list-view items. Preserve unrelated extended styles and selection behavior.
  SetCtlColors $JustDoInstallLog "475569" "F4F6FA"
  SendMessage $JustDoInstallLog 0x1001 0 0xFAF6F4
  SendMessage $JustDoInstallLog 0x1026 0 0xFAF6F4
  SendMessage $JustDoInstallLog 0x1024 0 0x695547
  SendMessage $JustDoInstallLog 0x1036 0x14001 0x14000
  System::Call 'user32::SetWindowPos(p $JustDoInstallLog, p 0, i 0, i 0, i 0, i 0, i 0x0037)i.r0'
  ; A blank small-image slot supplies real item inset and comfortable row
  ; height. Borrowed native images are left alone; only our empty list is owned.
  SendMessage $JustDoInstallLog 0x1002 1 0 $0
  ${If} $0 == 0
    !insertmacro InstallerScale $4 8
    !insertmacro InstallerScale $5 24
    System::Call 'comctl32::ImageList_Create(i r4, i r5, i 0x20, i 0, i 1)p.s'
    Pop $InstallerLogSpacingImages
    ${If} $InstallerLogSpacingImages != "0"
      System::Call 'user32::GetWindowLongW(p $JustDoInstallLog, i -16)i.r0'
      ; LVS_SHAREIMAGELISTS leaves teardown to this module, even if NSIS has
      ; already destroyed the log window before .onGUIEnd.
      IntOp $0 $0 | 0x0040
      System::Call 'user32::SetWindowLongW(p $JustDoInstallLog, i -16, i r0)i.r0'
      System::Call 'user32::GetWindowLongW(p $JustDoInstallLog, i -16)i.r0'
      IntOp $0 $0 & 0x0040
      ${If} $0 != 0
        SendMessage $JustDoInstallLog 0x1003 1 $InstallerLogSpacingImages
        SendMessage $JustDoInstallLog 0x1002 1 0 $0
      ${EndIf}
      ${If} $0 != $InstallerLogSpacingImages
        System::Call 'comctl32::ImageList_Destroy(p $InstallerLogSpacingImages)i.r0'
        StrCpy $InstallerLogSpacingImages "0"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ; NSIS sized its sole column before we widened the page. Reserve the native
  ; vertical scrollbar now, so later log entries cannot introduce a horizontal
  ; scrollbar or bring back the old narrow-column divider.
  System::Call 'user32::GetSystemMetricsForDpi(i 2, i $InstallerDpi)i.r0'
  IntOp $0 $R1 - $0
  System::Alloc 16
  Pop $4
  ${If} $4 != 0
    System::Call 'user32::GetClientRect(p $JustDoInstallLog, p r4)i.r5'
    ${If} $5 != 0
      System::Call '*$4(i, i, i .r0, i)'
      System::Call 'user32::GetWindowLongW(p $JustDoInstallLog, i -16)i.r5'
      IntOp $5 $5 & 0x00200000
      ${If} $5 == 0
        System::Call 'user32::GetSystemMetricsForDpi(i 2, i $InstallerDpi)i.r5'
        IntOp $0 $0 - $5
      ${EndIf}
    ${EndIf}
    System::Free $4
  ${EndIf}
  IntOp $0 $0 - 1
  SendMessage $JustDoInstallLog 0x101E 0 $0
  ${If} $InstallerLogFont != "0"
    SendMessage $JustDoInstallLog ${INSTALLER_WM_SETFONT} $InstallerLogFont 0
  ${Else}
    SendMessage $JustDoInstallLog ${INSTALLER_WM_SETFONT} $InstallerBaseFont 0
  ${EndIf}
  ShowWindow $JustDoInstallLog 0
  !insertmacro InstallerScale $1 80
  IntOp $1 $InstallerHeight - $1
  !insertmacro InstallerScale $2 160
  !insertmacro InstallerScale $3 25
  System::Call 'user32::SetWindowPos(p $JustDoShowLogButton, p 0, i $R0, i r1, i r2, i r3, i 0)i.r0'
  !insertmacro InstallerText $JustDoShowLogButton "查看安装详情" "Installation details"
  SendMessage $JustDoShowLogButton ${INSTALLER_WM_SETFONT} $InstallerBaseFont 0
  !insertmacro InstallerPaintButton $JustDoShowLogButton $InstallerBaseFont $InstallerDpi "${INSTALLER_BUTTON_LINK}" $InstallerDetailsButtonImage
  ShowWindow $JustDoShowLogButton 5
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${INSTALLER_WM_SETFONT} $InstallerBaseFont 0
  !insertmacro InstallerScale $1 80
  IntOp $1 $InstallerHeight - $1
  !insertmacro InstallerScale $2 140
  IntOp $2 $InstallerWidth - $2
  !insertmacro InstallerScale $3 112
  !insertmacro InstallerScale $4 36
  System::Call 'user32::SetWindowPos(p r0, p 0, i r2, i r1, i r3, i r4, i 0)i.r5'
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${INSTALLER_WM_SETFONT} $InstallerBaseFont 0
  System::Call 'user32::SetWindowPos(p r0, p 0, i r2, i r1, i r3, i r4, i 0)i.r5'
  !insertmacro InstallerText $0 "取消安装" "Cancel setup"
  ; NSIS disables cancellation during writes. Keep the inactive action out of
  ; the canvas; its real native button becomes Close on a failed result.
  ShowWindow $0 0
  !insertmacro InstallerInitializeButtonCues $HWNDPARENT
  StrCpy $InstallerPresentationReady "1"
  Push "${INSTALLER_STAGE_CHECKING}"
  Call InstallerPresentationSetStage
  !insertmacro JustDoSetInstallStatus "正在检查安装目录占用…" "Checking the installation location…"
  !insertmacro JustDoAddInstallActivity "已确认安装位置" "Installation location confirmed"
  !insertmacro JustDoLogInstallEvent "phase=install-page-shown status=checking-installation-location"
  ; This tiny native module uses a UI-owner Win32 timer. Its callback only
  ; formats elapsed time; it never re-enters the shared NSIS interpreter.
  File /oname=$PLUGINSDIR\installer-clock.dll "${INSTALLER_CLOCK_LIBRARY}"
  ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
  ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
    StrCpy $0 "已用时 "
  ${Else}
    StrCpy $0 "Elapsed "
  ${EndIf}
  System::Call '$PLUGINSDIR\installer-clock.dll::Start(p $InstallerElapsed, i $InstallerPresentationStarted, w r0)i.s'
  Pop $InstallerClockActive
  Call InstallerPresentationOpenMotion
  SendMessage $HWNDPARENT ${JUSTDO_WM_SETREDRAW} 1 0
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i ${JUSTDO_RDW_ATOMIC_REFRESH})i.r0'
  ClearErrors
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
