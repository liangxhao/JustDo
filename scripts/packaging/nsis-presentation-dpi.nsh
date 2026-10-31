!ifndef INSTALLER_PRESENTATION_DPI_INCLUDED
!define INSTALLER_PRESENTATION_DPI_INCLUDED

; Declare awareness before Windows creates the dialog. Without this manifest,
; GetDpiForWindow returns 96 and Windows stretches the entire rendered window,
; including text. The pinned NSIS compiler supports system DPI awareness; do
; not claim per-monitor awareness without a native DPI-change relayout path.
ManifestDPIAware true

!endif
