!ifndef JUSTDO_EXTRACTOR_LAUNCH_INCLUDED
!define JUSTDO_EXTRACTOR_LAUNCH_INCLUDED

; NSIS is a 32-bit process, including on 64-bit/ARM64 Windows. These structures
; belong to that caller; CreateProcessW can still launch the native Electron EXE.
Var JustDoExtractorExecutable
Var JustDoExtractorCommandLine
Var JustDoExtractorStdioLog
Var JustDoExtractorProcessHandle
Var JustDoExtractorLaunchError
Var JustDoExtractorStdioError
Var JustDoExtractorStdioCopied
Var JustDoExtractorStdioCopyError

Function JustDoLaunchResourceExtractor
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  StrCpy $JustDoExtractorProcessHandle "0"
  StrCpy $JustDoExtractorLaunchError ""
  StrCpy $JustDoExtractorStdioError ""
  ; SECURITY_ATTRIBUTES: these newly opened standard handles are inheritable.
  System::Call '*(i 12, p 0, i 1)p.r0'
  StrCpy $1 "-1"
  StrCpy $2 "-1"
  StrCpy $3 "0"
  StrCpy $4 "0"
  ${If} $0 == 0
    StrCpy $JustDoExtractorLaunchError "security-attributes-allocation-failed"
    Goto JustDoResourceLaunchCleanup
  ${EndIf}
  System::Call 'kernel32::CreateFileW(w "$JustDoExtractorStdioLog", i 0x4, i 3, p r0, i 4, i 0x80, p 0)p.r1 ?e'
  Pop $6
  ${If} $1 == -1
    StrCpy $JustDoExtractorStdioError "open-output-win32-$6"
    ; A logging failure must not prevent an otherwise valid installation.
    System::Call 'kernel32::CreateFileW(w "NUL", i 0x40000000, i 3, p r0, i 3, i 0x80, p 0)p.r1 ?e'
    Pop $6
  ${EndIf}
  System::Call 'kernel32::CreateFileW(w "NUL", i 0x80000000, i 3, p r0, i 3, i 0x80, p 0)p.r2 ?e'
  Pop $7
  ${If} $1 == -1
    StrCpy $JustDoExtractorLaunchError "open-standard-handle-win32-$6"
    Goto JustDoResourceLaunchCleanup
  ${ElseIf} $2 == -1
    StrCpy $JustDoExtractorLaunchError "open-standard-handle-win32-$7"
    Goto JustDoResourceLaunchCleanup
  ${EndIf}
  ; STARTUPINFOW: STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES, SW_HIDE.
  ; The two adjacent WORD fields are both zero and occupy one DWORD.
  System::Call '*(i 68, p 0, p 0, p 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0x101, i 0, p 0, p r2, p r1, p r1)p.r3'
  System::Alloc 16
  Pop $4
  ${If} $3 == 0
  ${OrIf} $4 == 0
    StrCpy $JustDoExtractorLaunchError "process-structure-allocation-failed"
    Goto JustDoResourceLaunchCleanup
  ${EndIf}
  ; Direct Unicode invocation keeps Chinese, spaces and shell characters literal.
  ; CREATE_NO_WINDOW also prevents a console for ELECTRON_RUN_AS_NODE.
  ; A register source avoids parsing the command line's quotes as System syntax.
  StrCpy $5 "$JustDoExtractorCommandLine"
  System::Call 'kernel32::CreateProcessW(w "$JustDoExtractorExecutable", w r5, p 0, p 0, i 1, i 0x08000000, p 0, p 0, p r3, p r4)i.r6 ?e'
  Pop $7
  ${If} $6 == 0
    StrCpy $JustDoExtractorLaunchError "create-process-win32-$7"
  ${Else}
    System::Call '*$4(p .r7, p .r8, i, i)'
    StrCpy $JustDoExtractorProcessHandle $7
    System::Call 'kernel32::CloseHandle(p r8)i.r5'
  ${EndIf}
  JustDoResourceLaunchCleanup:
  ${If} $1 != -1
    System::Call 'kernel32::CloseHandle(p r1)i.r5'
  ${EndIf}
  ${If} $2 != -1
    System::Call 'kernel32::CloseHandle(p r2)i.r5'
  ${EndIf}
  ${If} $0 != 0
    System::Free $0
  ${EndIf}
  ${If} $3 != 0
    System::Free $3
  ${EndIf}
  ${If} $4 != 0
    System::Free $4
  ${EndIf}
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

Function JustDoAppendExtractorStdioLog
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $JustDoExtractorStdioCopied "0"
  StrCpy $JustDoExtractorStdioCopyError ""
  StrCpy $0 "-1"
  StrCpy $1 "-1"
  StrCpy $2 "0"
  ${If} $JustDoResourceLogPath == ""
    StrCpy $JustDoExtractorStdioCopyError "resource-log-unavailable"
    Goto JustDoResourceStdioCopyCleanup
  ${EndIf}
  System::Call 'kernel32::CreateFileW(w "$JustDoExtractorStdioLog", i 0x80000000, i 3, p 0, i 3, i 0x80, p 0)p.r0 ?e'
  Pop $5
  ${If} $0 == -1
    StrCpy $JustDoExtractorStdioCopyError "open-source-win32-$5"
    Goto JustDoResourceStdioCopyCleanup
  ${EndIf}
  ; FILE_APPEND_DATA preserves previous/concurrent resource records.
  System::Call 'kernel32::CreateFileW(w "$JustDoResourceLogPath", i 0x4, i 3, p 0, i 4, i 0x80, p 0)p.r1 ?e'
  Pop $5
  ${If} $1 == -1
    StrCpy $JustDoExtractorStdioCopyError "open-target-win32-$5"
    Goto JustDoResourceStdioCopyCleanup
  ${EndIf}
  System::Alloc 65536
  Pop $2
  ${If} $2 == 0
    StrCpy $JustDoExtractorStdioCopyError "copy-buffer-allocation-failed"
    Goto JustDoResourceStdioCopyCleanup
  ${EndIf}
  JustDoResourceStdioCopyNext:
  System::Call 'kernel32::ReadFile(p r0, p r2, i 65536, *i .r3, p 0)i.r5 ?e'
  Pop $6
  ${If} $5 == 0
    StrCpy $JustDoExtractorStdioCopyError "read-output-win32-$6"
    Goto JustDoResourceStdioCopyCleanup
  ${EndIf}
  ${If} $3 == 0
    StrCpy $JustDoExtractorStdioCopied "1"
    Goto JustDoResourceStdioCopyCleanup
  ${EndIf}
  System::Call 'kernel32::WriteFile(p r1, p r2, i r3, *i .r4, p 0)i.r5 ?e'
  Pop $6
  ${If} $5 == 0
    StrCpy $JustDoExtractorStdioCopyError "append-output-win32-$6"
    Goto JustDoResourceStdioCopyCleanup
  ${EndIf}
  ${If} $4 != $3
    StrCpy $JustDoExtractorStdioCopyError "append-output-incomplete"
    Goto JustDoResourceStdioCopyCleanup
  ${EndIf}
  Goto JustDoResourceStdioCopyNext
  JustDoResourceStdioCopyCleanup:
  ${If} $0 != -1
    System::Call 'kernel32::CloseHandle(p r0)i.r5'
  ${EndIf}
  ${If} $1 != -1
    System::Call 'kernel32::CloseHandle(p r1)i.r5'
  ${EndIf}
  ${If} $2 != 0
    System::Free $2
  ${EndIf}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!endif
