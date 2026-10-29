!ifndef INSTALLER_PRESENTATION_CONTROLS_INCLUDED
!define INSTALLER_PRESENTATION_CONTROLS_INCLUDED

!define INSTALLER_BUTTON_PRIMARY "primary"
!define INSTALLER_BUTTON_SECONDARY "secondary"
!define INSTALLER_BUTTON_LINK "link"
!ifndef INSTALLER_BUTTON_BACKGROUND
  !define INSTALLER_BUTTON_BACKGROUND 0xFDFBFB
!endif
!ifndef INSTALLER_BUTTON_PRIMARY_FILL
  !define INSTALLER_BUTTON_PRIMARY_FILL 0xFF5F64E8
!endif
!ifndef INSTALLER_BUTTON_PRIMARY_TEXT
  !define INSTALLER_BUTTON_PRIMARY_TEXT 0xFFFFFF
!endif
!ifndef INSTALLER_BUTTON_SECONDARY_FILL
  !define INSTALLER_BUTTON_SECONDARY_FILL 0xFFEEEEF3
!endif
!ifndef INSTALLER_BUTTON_SECONDARY_TEXT
  !define INSTALLER_BUTTON_SECONDARY_TEXT 0x7E7474
!endif
!ifndef INSTALLER_BUTTON_LINK_TEXT
  !define INSTALLER_BUTTON_LINK_TEXT 0xB07762
!endif

; These private parameters are consumed synchronously. Call only from the
; existing SHOW/LEAVE/section presentation functions, never a script timer or
; subclass callback. Native BUTTON still owns input, focus, accessibility,
; WM_COMMAND, enabled state and visibility; its caption remains authoritative.
Var InstallerButtonTarget
Var InstallerButtonFont
Var InstallerButtonDpi
Var InstallerButtonKind
Var InstallerButtonOwnedImage
Var InstallerButtonResult
Var InstallerButtonImage
Var InstallerButtonRect
Var InstallerButtonScreenDC
Var InstallerButtonMemoryDC
Var InstallerButtonPriorImage
Var InstallerButtonPriorFont
Var InstallerButtonBackgroundBrush
Var InstallerButtonGraphicsToken
Var InstallerButtonGraphics
Var InstallerButtonPath
Var InstallerButtonFill

; Set the native caption and final size before painting. Give each BUTTON its
; own image variable, initialized to 0. Repainting replaces/frees its prior
; owned HBITMAP. The caller owns the borrowed HFONT; no font is created here.
!macro InstallerPaintButton _HANDLE _FONT _DPI _KIND _IMAGE
  Push ${_HANDLE}
  Push ${_FONT}
  Push ${_DPI}
  Push "${_KIND}"
  Push ${_IMAGE}
  Call InstallerPaintNativeButton
  Pop ${_IMAGE}
!macroend

; Run before destroying the BUTTON or freeing its font. This detaches/frees
; only the supplied owned image and resets the caller's image variable to 0.
!macro InstallerReleaseButton _HANDLE _IMAGE
  Push ${_HANDLE}
  Push ${_IMAGE}
  Call InstallerReleaseNativeButton
  Pop ${_IMAGE}
!macroend

; Hide mouse-initiated initial focus decoration once. Windows' dialog manager
; restores focus cues for keyboard navigation; do not call this on each poll.
!macro InstallerInitializeButtonCues _PARENT
  SendMessage ${_PARENT} 0x0127 0x00030001 0
!macroend

Function InstallerPaintNativeButton
  Pop $InstallerButtonOwnedImage
  Pop $InstallerButtonKind
  Pop $InstallerButtonDpi
  Pop $InstallerButtonFont
  Pop $InstallerButtonTarget
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
  StrCpy $InstallerButtonResult "0"
  StrCpy $InstallerButtonImage "0"
  StrCpy $InstallerButtonRect "0"
  StrCpy $InstallerButtonScreenDC "0"
  StrCpy $InstallerButtonMemoryDC "0"
  StrCpy $InstallerButtonPriorImage "0"
  StrCpy $InstallerButtonPriorFont "0"
  StrCpy $InstallerButtonBackgroundBrush "0"
  StrCpy $InstallerButtonGraphicsToken "0"
  StrCpy $InstallerButtonGraphics "0"
  StrCpy $InstallerButtonPath "0"
  StrCpy $InstallerButtonFill "0"
  ${If} $InstallerButtonTarget == ""
  ${OrIf} $InstallerButtonTarget == "0"
    Goto InstallerButtonPaintCleanup
  ${EndIf}
  System::Alloc 16
  Pop $InstallerButtonRect
  ${If} $InstallerButtonRect == "0"
    Goto InstallerButtonPaintCleanup
  ${EndIf}
  System::Call 'user32::GetClientRect(p $InstallerButtonTarget, p $InstallerButtonRect)i.r0'
  ${If} $0 == 0
    Goto InstallerButtonPaintCleanup
  ${EndIf}
  System::Call '*$InstallerButtonRect(i, i, i .r8, i .r9)'
  ${If} $8 < 1
  ${OrIf} $9 < 1
    Goto InstallerButtonPaintCleanup
  ${EndIf}
  System::Call 'user32::GetDC(p $InstallerButtonTarget)p.s'
  Pop $InstallerButtonScreenDC
  ${If} $InstallerButtonScreenDC == "0"
    Goto InstallerButtonPaintCleanup
  ${EndIf}
  System::Call 'gdi32::CreateCompatibleDC(p $InstallerButtonScreenDC)p.s'
  Pop $InstallerButtonMemoryDC
  ; The surface is opaque. An explicit 24bpp DIB avoids accidental alpha from
  ; mixing GDI+ fills with GDI text in a display-format 32bpp bitmap; themed
  ; BUTTON may otherwise blend the text's cleared alpha as broken glyphs.
  IntOp $1 0 - $9
  System::Call '*(i 40, i r8, i r1, i 0x00180001, i 0, i 0, i 0, i 0, i 0, i 0)p.r0'
  ${If} $0 == 0
    Goto InstallerButtonPaintCleanup
  ${EndIf}
  System::Call 'gdi32::CreateDIBSection(p $InstallerButtonScreenDC, p r0, i 0, *p .r2, p 0, i 0)p.s'
  Pop $InstallerButtonImage
  System::Free $0
  ${If} $InstallerButtonMemoryDC == "0"
  ${OrIf} $InstallerButtonImage == "0"
    Goto InstallerButtonPaintCleanup
  ${EndIf}
  System::Call 'gdi32::SelectObject(p $InstallerButtonMemoryDC, p $InstallerButtonImage)p.s'
  Pop $InstallerButtonPriorImage
  System::Call 'gdi32::CreateSolidBrush(i ${INSTALLER_BUTTON_BACKGROUND})p.s'
  Pop $InstallerButtonBackgroundBrush
  System::Call 'user32::FillRect(p $InstallerButtonMemoryDC, p $InstallerButtonRect, p $InstallerButtonBackgroundBrush)i.r0'
  ${If} $0 == 0
    Goto InstallerButtonPaintCleanup
  ${EndIf}
  StrCpy $7 ${INSTALLER_BUTTON_LINK_TEXT}
  ${If} $InstallerButtonKind != "${INSTALLER_BUTTON_LINK}"
    ; GDI+ ships with Windows. Its antialiasing smooths the rounded fill; all
    ; temporary GDI+ resources are released before returning to the engine.
    System::Call '*(i 1, p 0, i 0, i 0)p.r0'
    ${If} $0 == 0
      Goto InstallerButtonPaintCleanup
    ${EndIf}
    StrCpy $1 -1
    System::Call 'gdiplus::GdiplusStartup(*p .r2, p r0, p 0)i.r1'
    System::Free $0
    ${If} $1 != 0
      Goto InstallerButtonPaintCleanup
    ${EndIf}
    StrCpy $InstallerButtonGraphicsToken $2
    System::Call 'gdiplus::GdipCreateFromHDC(p $InstallerButtonMemoryDC, *p .r0)i.r1'
    ${If} $1 != 0
      Goto InstallerButtonPaintCleanup
    ${EndIf}
    StrCpy $InstallerButtonGraphics $0
    System::Call 'gdiplus::GdipSetSmoothingMode(p $InstallerButtonGraphics, i 4)i.r1'
    System::Call 'gdiplus::GdipCreatePath(i 0, *p .r0)i.r1'
    ${If} $1 != 0
      Goto InstallerButtonPaintCleanup
    ${EndIf}
    StrCpy $InstallerButtonPath $0
    IntOp $4 $InstallerButtonDpi * 20
    IntOp $4 $4 / 96
    ${If} $4 > $9
      StrCpy $4 $9
    ${EndIf}
    ${If} $4 > $8
      StrCpy $4 $8
    ${EndIf}
    IntOp $5 $8 - $4
    IntOp $5 $5 - 1
    IntOp $6 $9 - $4
    IntOp $6 $6 - 1
    ; System has no floating-point parameter type. ArcI takes integer geometry;
    ; its final two REAL values use their exact IEEE-754 bits on the x86 stack:
    ; 0=0, 90=0x42B40000, 180=0x43340000, 270=0x43870000.
    System::Call 'gdiplus::GdipAddPathArcI(p $InstallerButtonPath, i 0, i 0, i r4, i r4, i 0x43340000, i 0x42B40000)i.r1'
    ${If} $1 != 0
      Goto InstallerButtonPaintCleanup
    ${EndIf}
    System::Call 'gdiplus::GdipAddPathArcI(p $InstallerButtonPath, i r5, i 0, i r4, i r4, i 0x43870000, i 0x42B40000)i.r1'
    ${If} $1 != 0
      Goto InstallerButtonPaintCleanup
    ${EndIf}
    System::Call 'gdiplus::GdipAddPathArcI(p $InstallerButtonPath, i r5, i r6, i r4, i r4, i 0, i 0x42B40000)i.r1'
    ${If} $1 != 0
      Goto InstallerButtonPaintCleanup
    ${EndIf}
    System::Call 'gdiplus::GdipAddPathArcI(p $InstallerButtonPath, i 0, i r6, i r4, i r4, i 0x42B40000, i 0x42B40000)i.r1'
    ${If} $1 != 0
      Goto InstallerButtonPaintCleanup
    ${EndIf}
    System::Call 'gdiplus::GdipClosePathFigure(p $InstallerButtonPath)i.r1'
    StrCpy $0 ${INSTALLER_BUTTON_SECONDARY_FILL}
    StrCpy $7 ${INSTALLER_BUTTON_SECONDARY_TEXT}
    ${If} $InstallerButtonKind == "${INSTALLER_BUTTON_PRIMARY}"
      StrCpy $0 ${INSTALLER_BUTTON_PRIMARY_FILL}
      StrCpy $7 ${INSTALLER_BUTTON_PRIMARY_TEXT}
    ${EndIf}
    System::Call 'gdiplus::GdipCreateSolidFill(i r0, *p .r2)i.r1'
    ${If} $1 != 0
      Goto InstallerButtonPaintCleanup
    ${EndIf}
    StrCpy $InstallerButtonFill $2
    System::Call 'gdiplus::GdipFillPath(p $InstallerButtonGraphics, p $InstallerButtonFill, p $InstallerButtonPath)i.r1'
    ${If} $1 != 0
      Goto InstallerButtonPaintCleanup
    ${EndIf}
    System::Call 'gdiplus::GdipDeleteGraphics(p $InstallerButtonGraphics)i.r1'
    StrCpy $InstallerButtonGraphics "0"
  ${EndIf}
  ${If} $InstallerButtonFont != "0"
  ${AndIf} $InstallerButtonFont != ""
    System::Call 'gdi32::SelectObject(p $InstallerButtonMemoryDC, p $InstallerButtonFont)p.s'
    Pop $InstallerButtonPriorFont
  ${EndIf}
  System::Call 'gdi32::SetBkMode(p $InstallerButtonMemoryDC, i 1)i.r0'
  System::Call 'gdi32::SetTextColor(p $InstallerButtonMemoryDC, i r7)i.r0'
  System::Call 'user32::GetWindowTextW(p $InstallerButtonTarget, w .r3, i ${NSIS_MAX_STRLEN})i.r0'
  ; VCENTER | SINGLELINE | HIDEPREFIX, plus CENTER for solid buttons. The link
  ; aligns with the content edge; the native caption retains its accelerator.
  StrCpy $6 0x00100025
  ${If} $InstallerButtonKind == "${INSTALLER_BUTTON_LINK}"
    StrCpy $6 0x00100024
  ${EndIf}
  System::Call 'user32::DrawTextW(p $InstallerButtonMemoryDC, w r3, i -1, p $InstallerButtonRect, i r6)i.r0'
  ; Restore selections before handing the image to BUTTON or deleting the DC.
  System::Call 'gdi32::SelectObject(p $InstallerButtonMemoryDC, p $InstallerButtonPriorImage)p.r0'
  StrCpy $InstallerButtonPriorImage "0"
  ; Preserve every native style, including default-pushbutton and tab-stop.
  ; Keep ComCtl6 theming: disabling themes brings back classic bitmap borders.
  System::Call 'user32::GetWindowLongW(p $InstallerButtonTarget, i -16)i.r0'
  IntOp $0 $0 & 0xFFFFFFBF
  IntOp $0 $0 | 0x00008080
  System::Call 'user32::SetWindowLongW(p $InstallerButtonTarget, i -16, i r0)i.r1'
  System::Call 'uxtheme::SetWindowTheme(p $InstallerButtonTarget, p 0, p 0)i.r1'
  SendMessage $InstallerButtonTarget 0x00F7 0 $InstallerButtonImage
  ${If} $InstallerButtonOwnedImage != "0"
  ${AndIf} $InstallerButtonOwnedImage != ""
    System::Call 'gdi32::DeleteObject(p $InstallerButtonOwnedImage)i.r0'
  ${EndIf}
  StrCpy $InstallerButtonResult $InstallerButtonImage
  StrCpy $InstallerButtonImage "0"
  System::Call 'user32::InvalidateRect(p $InstallerButtonTarget, p 0, i 0)i.r0'

  InstallerButtonPaintCleanup:
  ${If} $InstallerButtonGraphics != "0"
    System::Call 'gdiplus::GdipDeleteGraphics(p $InstallerButtonGraphics)i.r0'
  ${EndIf}
  ${If} $InstallerButtonPath != "0"
    System::Call 'gdiplus::GdipDeletePath(p $InstallerButtonPath)i.r0'
  ${EndIf}
  ${If} $InstallerButtonFill != "0"
    System::Call 'gdiplus::GdipDeleteBrush(p $InstallerButtonFill)i.r0'
  ${EndIf}
  ${If} $InstallerButtonGraphicsToken != "0"
    System::Call 'gdiplus::GdiplusShutdown(p $InstallerButtonGraphicsToken)'
  ${EndIf}
  ${If} $InstallerButtonMemoryDC != "0"
    ${If} $InstallerButtonPriorImage != "0"
      System::Call 'gdi32::SelectObject(p $InstallerButtonMemoryDC, p $InstallerButtonPriorImage)p.r0'
    ${EndIf}
    ${If} $InstallerButtonPriorFont != "0"
      System::Call 'gdi32::SelectObject(p $InstallerButtonMemoryDC, p $InstallerButtonPriorFont)p.r0'
    ${EndIf}
    System::Call 'gdi32::DeleteDC(p $InstallerButtonMemoryDC)i.r0'
  ${EndIf}
  ${If} $InstallerButtonScreenDC != "0"
    System::Call 'user32::ReleaseDC(p $InstallerButtonTarget, p $InstallerButtonScreenDC)i.r0'
  ${EndIf}
  ${If} $InstallerButtonImage != "0"
    System::Call 'gdi32::DeleteObject(p $InstallerButtonImage)i.r0'
  ${EndIf}
  ${If} $InstallerButtonBackgroundBrush != "0"
    System::Call 'gdi32::DeleteObject(p $InstallerButtonBackgroundBrush)i.r0'
  ${EndIf}
  ${If} $InstallerButtonRect != "0"
    System::Free $InstallerButtonRect
  ${EndIf}
  ; A caption may have changed since the previous render. If repainting fails,
  ; show that authoritative native caption rather than retaining stale pixels.
  ${If} $InstallerButtonResult == "0"
  ${AndIf} $InstallerButtonOwnedImage != "0"
  ${AndIf} $InstallerButtonOwnedImage != ""
    SendMessage $InstallerButtonTarget 0x00F6 0 0 $0
    ${If} $0 == $InstallerButtonOwnedImage
      SendMessage $InstallerButtonTarget 0x00F7 0 0
      System::Call 'user32::GetWindowLongW(p $InstallerButtonTarget, i -16)i.r0'
      IntOp $0 $0 & 0xFFFF7F7F
      System::Call 'user32::SetWindowLongW(p $InstallerButtonTarget, i -16, i r0)i.r1'
      System::Call 'user32::InvalidateRect(p $InstallerButtonTarget, p 0, i 1)i.r0'
    ${EndIf}
    System::Call 'gdi32::DeleteObject(p $InstallerButtonOwnedImage)i.r0'
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
  Push $InstallerButtonResult
FunctionEnd

Function InstallerReleaseNativeButton
  Pop $InstallerButtonOwnedImage
  Pop $InstallerButtonTarget
  Push $0
  Push $1
  Push $R9
  StrCpy $R9 "0"
  ${If} ${Errors}
    StrCpy $R9 "1"
  ${EndIf}
  ${If} $InstallerButtonOwnedImage != "0"
  ${AndIf} $InstallerButtonOwnedImage != ""
    SendMessage $InstallerButtonTarget 0x00F6 0 0 $0
    ${If} $0 == $InstallerButtonOwnedImage
      SendMessage $InstallerButtonTarget 0x00F7 0 0
      System::Call 'user32::GetWindowLongW(p $InstallerButtonTarget, i -16)i.r0'
      IntOp $0 $0 & 0xFFFF7F7F
      System::Call 'user32::SetWindowLongW(p $InstallerButtonTarget, i -16, i r0)i.r1'
    ${EndIf}
    System::Call 'gdi32::DeleteObject(p $InstallerButtonOwnedImage)i.r0'
  ${EndIf}
  ${If} $R9 == "1"
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $R9
  Pop $1
  Pop $0
  Push "0"
FunctionEnd

!endif
