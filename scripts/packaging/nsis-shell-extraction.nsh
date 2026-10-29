!ifndef INSTALLER_SHELL_EXTRACTION_INCLUDED
!define INSTALLER_SHELL_EXTRACTION_INCLUDED

; The existing hidden-process launcher owns handles and diagnostic capture for
; both application files and bundled resources. This phase has its own measured
; percentage; it is never a percentage of the complete installation.
Var InstallerShellExecutable
Var InstallerShellArchive
Var InstallerShellLog
Var InstallerShellExitCode
Var InstallerShellProgress
Var InstallerShellProgressOffset
Var InstallerShellProgressMode
Var InstallerShellProgressDigits
Var InstallerShellProgressValue

!define INSTALLER_SHELL_PROGRESS_BUFFER_BYTES 1024

Function InstallerResetShellProgress
  StrCpy $InstallerShellProgress "-1"
  StrCpy $InstallerShellProgressOffset "0"
  StrCpy $InstallerShellProgressMode "0"
  StrCpy $InstallerShellProgressDigits "0"
  StrCpy $InstallerShellProgressValue "0"
FunctionEnd

Function InstallerRenderShellProgress
  ${If} ${Silent}
    Return
  ${EndIf}
  ${If} $JustDoNativeProgressBar != ""
    SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETRANGE32} 0 100
    SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETPOS} $InstallerShellProgress 0
  ${EndIf}
  !insertmacro JustDoSetInstallStatus \
    "应用文件解压：$InstallerShellProgress%…" \
    "Extracting application files: $InstallerShellProgress%…"
FunctionEnd

Function InstallerPollShellProgress
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  StrCpy $0 "-1"
  StrCpy $1 "0"

  ; The child is still writing this file. Explicit read/write/delete sharing
  ; keeps progress best-effort without interfering with capture or extraction.
  System::Call 'kernel32::CreateFileW(w "$InstallerShellLog", i 0x80000000, i 7, p 0, i 3, i 0x80, p 0)p.r0'
  ${If} $0 == -1
    Goto InstallerShellProgressCleanup
  ${EndIf}
  System::Call 'kernel32::SetFilePointerEx(p r0, l "$InstallerShellProgressOffset", p 0, i 0)i.r7'
  ${If} $7 == 0
    Goto InstallerShellProgressCleanup
  ${EndIf}
  System::Alloc ${INSTALLER_SHELL_PROGRESS_BUFFER_BYTES}
  Pop $1
  ${If} $1 == 0
    Goto InstallerShellProgressCleanup
  ${EndIf}
  ; Bound work per poll even when diagnostics are large. The prefix parser is
  ; carried across reads, including a percentage split between two chunks.
  System::Call 'kernel32::ReadFile(p r0, p r1, i ${INSTALLER_SHELL_PROGRESS_BUFFER_BYTES}, *i .r2, p 0)i.r7'
  ${If} $7 == 0
  ${OrIf} $2 == 0
    Goto InstallerShellProgressCleanup
  ${EndIf}
  System::Int64Op $InstallerShellProgressOffset + $2
  Pop $InstallerShellProgressOffset
  StrCpy $3 $1
  StrCpy $5 "0"

  InstallerShellProgressNextByte:
  ${If} $5 >= $2
    Goto InstallerShellProgressCleanup
  ${EndIf}
  System::Call '*$3(&i1 .r4)'
  IntOp $3 $3 + 1
  IntOp $5 $5 + 1
  ${If} $4 == 13
  ${OrIf} $4 == 10
    StrCpy $InstallerShellProgressMode "0"
    StrCpy $InstallerShellProgressDigits "0"
    StrCpy $InstallerShellProgressValue "0"
  ${ElseIf} $InstallerShellProgressMode != "2"
    ${If} $InstallerShellProgressMode == "0"
    ${AndIf} $4 == 32
      ; A progress record is an ASCII prefix: optional padding, digits, '%'.
    ${ElseIf} $InstallerShellProgressMode == "0"
    ${AndIf} $4 == 9
      ; Accept a leading tab as whitespace without decoding UTF-8 filenames.
    ${ElseIf} $4 >= 48
    ${AndIf} $4 <= 57
      ${If} $InstallerShellProgressDigits >= 3
        StrCpy $InstallerShellProgressMode "2"
      ${Else}
        IntOp $6 $4 - 48
        IntOp $InstallerShellProgressValue $InstallerShellProgressValue * 10
        IntOp $InstallerShellProgressValue $InstallerShellProgressValue + $6
        IntOp $InstallerShellProgressDigits $InstallerShellProgressDigits + 1
        StrCpy $InstallerShellProgressMode "1"
      ${EndIf}
    ${ElseIf} $4 == 37
    ${AndIf} $InstallerShellProgressMode == "1"
      ${If} $InstallerShellProgressValue <= 100
      ${AndIf} $InstallerShellProgressValue > $InstallerShellProgress
        StrCpy $InstallerShellProgress $InstallerShellProgressValue
        Call InstallerRenderShellProgress
      ${EndIf}
      StrCpy $InstallerShellProgressMode "2"
    ${Else}
      ; Headers, scan sizes, malformed values and '%' inside paths do not
      ; establish a percentage. Ignore the remainder of this CR/LF record.
      StrCpy $InstallerShellProgressMode "2"
    ${EndIf}
  ${EndIf}
  Goto InstallerShellProgressNextByte

  InstallerShellProgressCleanup:
  ${If} $0 != -1
    System::Call 'kernel32::CloseHandle(p r0)i.r7'
  ${EndIf}
  ${If} $1 != 0
    System::Free $1
  ${EndIf}
  ; A missing, locked or unreadable progress log never changes the installation
  ; outcome or leaks an NSIS error flag into subsequent payload checks.
  ClearErrors
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function InstallerExtractShell
  Push $0
  Push $1
  Push $2
  Push $3
  Call InstallerResetShellProgress
  !ifmacrodef InstallerPresentationShellStart
    !insertmacro InstallerPresentationShellStart
  !endif
  StrCpy $InstallerShellExitCode "unavailable"
  StrCpy $JustDoExtractorExecutable "$InstallerShellExecutable"
  ; '.\' is not needed: a final '\.' keeps the quoted output argument from
  ; ending in an escaped quote when a selected directory has a trailing slash.
  ; Direct Unicode invocation preserves Chinese, spaces, %, '&' and '!'.
  StrCpy $JustDoExtractorCommandLine '$\"$InstallerShellExecutable$\" x -y -aoa -bsp1 -sccUTF-8 $\"-o$INSTDIR\.$\" $\"$InstallerShellArchive$\"'
  StrCpy $JustDoExtractorStdioLog "$InstallerShellLog"
  ; The previous implementation truncated the per-session shell capture. Keep
  ; that behavior; a failed deletion makes diagnostics unavailable, not fatal.
  Delete "$InstallerShellLog"
  StrCpy $JustDoExtractorActive "1"
  Call JustDoLaunchResourceExtractor
  ${If} $JustDoExtractorLaunchError != ""
    StrCpy $InstallerShellExitCode "launch-$JustDoExtractorLaunchError"
    Goto InstallerShellProcessDone
  ${EndIf}
  ${If} ${Silent}
    System::Call 'kernel32::WaitForSingleObject(p $JustDoExtractorProcessHandle, i -1)i.r0 ?e'
    Pop $1
  ${Else}
    InstallerShellWait:
    System::Call 'kernel32::WaitForSingleObject(p $JustDoExtractorProcessHandle, i 0)i.r0 ?e'
    Pop $1
    ${If} $0 == 258
      Call InstallerPollShellProgress
      !ifmacrodef InstallerPresentationPoll
        !insertmacro InstallerPresentationPoll
      !endif
      Sleep 150
      Goto InstallerShellWait
    ${EndIf}
  ${EndIf}
  ${If} $0 != 0
    !insertmacro JustDoLogInstallEvent "phase=shell-extractor-wait-fallback wait=$0 win32=$1"
    System::Call 'kernel32::WaitForSingleObject(p $JustDoExtractorProcessHandle, i -1)i.r0 ?e'
    Pop $1
  ${EndIf}
  ${If} $0 == 0
    System::Call 'kernel32::GetExitCodeProcess(p $JustDoExtractorProcessHandle, *i .r2)i.r0 ?e'
    Pop $1
    ${If} $0 != 0
      StrCpy $InstallerShellExitCode $2
    ${Else}
      StrCpy $InstallerShellExitCode "exit-code-win32-$1"
    ${EndIf}
  ${Else}
    StrCpy $InstallerShellExitCode "wait-win32-$1"
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p $JustDoExtractorProcessHandle)i.r0'
  StrCpy $JustDoExtractorProcessHandle "0"

  InstallerShellProcessDone:
  StrCpy $JustDoExtractorActive "0"
  Call InstallerPollShellProgress
  ; Fast extractions can finish without printing 100%. Only a real successful
  ; process exit establishes completion of this phase, never whole setup.
  ${If} $InstallerShellExitCode == "0"
    StrCpy $InstallerShellProgress "100"
    Call InstallerRenderShellProgress
  ${EndIf}
  Call JustDoAppendExtractorStdioLog
  ClearErrors
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!endif
