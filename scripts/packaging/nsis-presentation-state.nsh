!ifndef INSTALLER_PRESENTATION_STATE_INCLUDED
!define INSTALLER_PRESENTATION_STATE_INCLUDED

!define INSTALLER_STAGE_CHECKING "checking"
!define INSTALLER_STAGE_SHELL "shell"
!define INSTALLER_STAGE_RESOURCES "resources"
!define INSTALLER_STAGE_FINALIZING "finalizing"
!define INSTALLER_STAGE_COMPLETE "complete"
!define INSTALLER_STAGE_FAILED "failed"

Var InstallerPresentationStage
Var InstallerOpenOnFinish
Var InstallerElapsed
Var InstallerClockActive

!macro InstallerMarkPhase
  ${If} $InstallerClockActive == "1"
    ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
    ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
      System::Call '$PLUGINSDIR\installer-clock.dll::MarkPhase(p $InstallerElapsed, w "本步 ")i'
    ${Else}
      System::Call '$PLUGINSDIR\installer-clock.dll::MarkPhase(p $InstallerElapsed, w "Step ")i'
    ${EndIf}
  ${EndIf}
!macroend

!endif
