Var InstallerOldExecutable
Var InstallerOldArguments
Var InstallerOldScope
Var InstallerOldAttempt
Var InstallerOldResult
Var InstallerOldError
Var InstallerOldIdentityPath
Var InstallerOldIdentityKind
Var InstallerOldIdentity
Var InstallerOldIdentityHandle
Var InstallerOldKeepIdentityOpen
Var InstallerOldDirectory
Var InstallerOldDirectoryIdentity
Var InstallerOldFileIdentity
Var InstallerOldRegistration
Var InstallerOldLaunchMode
Var InstallerOldRetry
Var InstallerOldRetryAllowed
!define /math INSTALLER_PREVIOUS_COMMAND_LIMIT ${NSIS_MAX_STRLEN} - 1

Function InstallerReadPreviousIdentity
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
  StrCpy $InstallerOldIdentity ""
  StrCpy $InstallerOldIdentityHandle "-1"
  StrCpy $R1 7
  ${If} $InstallerOldKeepIdentityOpen == "1"
    StrCpy $R1 1
  ${EndIf}
  System::Call 'kernel32::CreateFileW(w "$InstallerOldIdentityPath", i 0x80, i R1, p 0, i 3, i 0x02200000, p 0)p.r0'
  ${If} $0 != -1
    System::Alloc 52
    Pop $9
    ${If} $9 != 0
      System::Call 'kernel32::GetFileInformationByHandle(p r0, p r9)i.r2'
      ${If} $2 != 0
        System::Call '*$9(i .R1, i .r3, i .r4, i, i, i .r5, i .r6, i, i .r8, i .r2, i, i, i)'
        IntOp $R1 $R1 & 0x410
        ${If} $R1 == $InstallerOldIdentityKind
          System::Call 'kernel32::GetFileInformationByHandleEx(p r0, i 18, p r9, i 24)i.r7'
          ${If} $7 != 0
            System::Call '*$9(l .r7, i .r1, i .R0, i .r2, i .R1)'
            IntOp $R0 $R0 | $1
            IntOp $R0 $R0 | $2
            IntOp $R0 $R0 | $R1
            ${If} $R0 != 0
              System::Call '*$9(l .r7, i .r1, i .R0, i .r2, i .R1)'
              StrCpy $InstallerOldIdentity "$7:$1:$R0:$2:$R1:$4:$3"
              ${If} $InstallerOldIdentityKind == 0
                StrCpy $InstallerOldIdentity "$InstallerOldIdentity:$6:$5:$8"
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
      System::Free $9
    ${EndIf}
    ${If} $InstallerOldKeepIdentityOpen == "1"
    ${AndIf} $InstallerOldIdentity != ""
      StrCpy $InstallerOldIdentityHandle $0
    ${Else}
      System::Call 'kernel32::CloseHandle(p r0)i'
    ${EndIf}
  ${EndIf}
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

Function InstallerAskPreviousRetry
  Push $0
  StrCpy $InstallerOldRetry "0"
  ${IfNot} ${Silent}
  ${AndIf} $InstallerOldAttempt == 1
  ${AndIf} $InstallerOldRetryAllowed == "1"
  ${AndIf} $InstallerOldDirectoryIdentity != ""
  ${AndIf} $InstallerOldFileIdentity != ""
  ${AndIf} $InstallerOldResult != "unconfirmed"
    ${If} $InstallerOldResult == "exited"
      !insertmacro InstallerPreviousRetryText $0 \
        "清理旧版本未成功（退出码 $InstallerOldError）。" \
        "The previous uninstaller returned exit code $InstallerOldError."
    ${Else}
      !insertmacro InstallerPreviousRetryText $0 \
        "无法启动旧版卸载程序（错误 $InstallerOldError）。" \
        "The previous uninstaller could not start (error $InstallerOldError)."
    ${EndIf}
    !insertmacro InstallerShowPreviousFailure
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$0" /SD IDCANCEL IDRETRY InstallerOldRetryAccepted
    Goto InstallerOldRetryDone
    InstallerOldRetryAccepted:
    StrCpy $InstallerOldRetry "1"
  ${EndIf}
  InstallerOldRetryDone:
  !insertmacro JustDoLogInstallEvent "phase=previous-uninstaller-retry-decision root=$InstallerOldScope attempt=$InstallerOldAttempt retry=$InstallerOldRetry result=$InstallerOldResult code=$InstallerOldError"
  Pop $0
FunctionEnd

Function InstallerRunPreviousUninstaller
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  StrCpy $InstallerOldResult "not-started"
  StrCpy $InstallerOldError "allocation-failed"
  System::Call '*(i 68, p 0, p 0, p 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, p 0, p 0, p 0, p 0)p.r0'
  System::Alloc 16
  Pop $1
  ${If} $0 == 0
  ${OrIf} $1 == 0
    Goto InstallerOldLaunchCleanup
  ${EndIf}
  StrCpy $2 '"$InstallerOldExecutable" $InstallerOldArguments'
  StrLen $3 $2
  ${If} $3 >= ${INSTALLER_PREVIOUS_COMMAND_LIMIT}
    StrCpy $InstallerOldResult "unconfirmed"
    StrCpy $InstallerOldError "command-line-too-long"
    !insertmacro JustDoLogInstallEvent "phase=previous-uninstaller-command-rejected reason=length"
    Goto InstallerOldLaunchCleanup
  ${EndIf}
  System::Call 'kernel32::CreateProcessW(w "$InstallerOldExecutable", w r2, p 0, p 0, i 0, i 0x04000000, p 0, p 0, p r0, p r1)i.r3 ?e'
  Pop $InstallerOldError
  ${If} $InstallerOldIdentityHandle != -1
    System::Call 'kernel32::CloseHandle(p $InstallerOldIdentityHandle)i'
    StrCpy $InstallerOldIdentityHandle "-1"
  ${EndIf}
  ${If} $3 == 0
    Goto InstallerOldLaunchCleanup
  ${EndIf}
  System::Call '*$1(p .r3, p .r4, i .r5, i)'
  StrCpy $InstallerOldChildActive "1"
  !insertmacro InstallerShowPreviousWait "0"
  System::Call 'kernel32::CloseHandle(p r4)i'
  System::Call 'kernel32::GetTickCount()i.r4'
  !insertmacro JustDoLogInstallEvent "phase=previous-uninstaller-start root=$InstallerOldScope attempt=$InstallerOldAttempt launch=$InstallerOldLaunchMode child-pid=$5"
  StrCpy $6 "0"
  ${If} ${Silent}
    System::Call 'kernel32::WaitForSingleObject(p r3, i -1)i.r2 ?e'
    Pop $InstallerOldError
  ${Else}
    InstallerOldWait:
    System::Call 'kernel32::WaitForSingleObject(p r3, i 250)i.r2 ?e'
    Pop $InstallerOldError
    ${If} $2 == 258
      System::Call 'kernel32::GetTickCount()i.r7'
      IntOp $7 $7 - $4
      IntOp $7 $7 / 1000
      ${If} $7 != $6
        StrCpy $6 $7
        !insertmacro InstallerShowPreviousWait "$6"
      ${EndIf}
      Goto InstallerOldWait
    ${EndIf}
  ${EndIf}
  StrCpy $InstallerOldResult "unconfirmed"
  ${If} $2 != 0
    !insertmacro JustDoLogInstallEvent "phase=previous-uninstaller-wait-degraded root=$InstallerOldScope attempt=$InstallerOldAttempt child-pid=$5 win32=$InstallerOldError"
    System::Call 'kernel32::WaitForSingleObject(p r3, i -1)i.r2 ?e'
    Pop $InstallerOldError
  ${EndIf}
  ${If} $2 == 0
    System::Call 'kernel32::GetExitCodeProcess(p r3, *i .r2)i.r7 ?e'
    Pop $InstallerOldError
    ${If} $7 != 0
      StrCpy $InstallerOldResult "exited"
      StrCpy $InstallerOldError $2
    ${EndIf}
  ${Else}
    !insertmacro JustDoLogInstallEvent "phase=previous-uninstaller-lifetime-unconfirmed root=$InstallerOldScope attempt=$InstallerOldAttempt child-pid=$5 win32=$InstallerOldError"
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r3)i'
  StrCpy $InstallerOldChildActive "0"
  System::Call 'kernel32::GetTickCount()i.r7'
  IntOp $7 $7 - $4
  !insertmacro JustDoLogInstallEvent "phase=previous-uninstaller-returned root=$InstallerOldScope attempt=$InstallerOldAttempt child-pid=$5 result=$InstallerOldResult code=$InstallerOldError duration-ms=$7"
  InstallerOldLaunchCleanup:
  ${If} $InstallerOldIdentityHandle != -1
    System::Call 'kernel32::CloseHandle(p $InstallerOldIdentityHandle)i'
    StrCpy $InstallerOldIdentityHandle "-1"
  ${EndIf}
  ${If} $1 != 0
    System::Free $1
  ${EndIf}
  ${If} $0 != 0
    System::Free $0
  ${EndIf}
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
