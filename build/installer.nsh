!macro runToolkitCleanup ARGUMENTS
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop-toolkit-processes.ps1 "${BUILD_RESOURCES_DIR}\stop-toolkit-processes.ps1"
  nsExec::ExecToStack /TIMEOUT=90000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-toolkit-processes.ps1" ${ARGUMENTS}'
  Pop $R0
  Pop $R1
  DetailPrint "$R1"
!macroend

; An elevated copy only closes verified processes. The original installer keeps
; its user, registry hive and installation mode, even with alternate UAC credentials.
!macro preInit
  !ifndef BUILD_UNINSTALLER
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/toolkit-cleanup=" $R1
    ${IfNot} ${Errors}
      SetErrorLevel 5
      ${If} ${UAC_IsAdmin}
        IntOp $R2 $R1 + 0
        ${If} $R2 > 0
          !insertmacro runToolkitCleanup '-InstallerPid $R2 -InstallerFile "$EXEPATH" -RegistrationKey "${INSTALL_REGISTRY_KEY}"'
          ${If} $R0 == 0
            SetErrorLevel 0
          ${EndIf}
        ${EndIf}
      ${EndIf}
      Quit
    ${EndIf}
  !endif
!macroend

!macro checkToolkitProcesses
  ReadRegStr $R3 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R4 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro runToolkitCleanup '-InstallDir "$INSTDIR\." -PreviousUserDir "$R3\." -PreviousMachineDir "$R4\."'
!macroend

!macro customCheckAppRunning
  DetailPrint "正在等待旧版工具箱及其子进程退出…"
  toolkit_process_retry:
  !insertmacro checkToolkitProcesses
  !ifndef BUILD_UNINSTALLER
    ${If} $R0 == 5
    ${AndIfNot} ${UAC_IsAdmin}
      System::Call 'kernel32::GetCurrentProcessId() i.r0'
      ${StdUtils.ExecShellWaitEx} $R1 $R2 "$EXEPATH" "runas" "/S /toolkit-cleanup=$0"
      ${If} $R1 == "ok"
        ${StdUtils.WaitForProcEx} $R0 $R2
        ${If} $R0 == 0
          ; Do not invoke a legacy uninstaller until the ordinary-user check passes.
          !insertmacro checkToolkitProcesses
        ${EndIf}
      ${ElseIf} $R2 == 1223
        SetErrorLevel 1223
        Quit
      ${Else}
        StrCpy $R0 5
      ${EndIf}
    ${EndIf}
  !endif
  ${If} $R0 != 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "旧版工具箱仍在使用。请关闭旧版窗口后重试。日志：$TEMP\toolkit-install-processes.log" /SD IDCANCEL IDRETRY toolkit_process_retry
    ${If} $R0 == 5
      SetErrorLevel 5
    ${Else}
      SetErrorLevel 2
    ${EndIf}
    Quit
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    ; An update from an internal installation keeps its own notification settings.
    ; The public installer carries no machine's webhook.
    IfFileExists "$INSTDIR\resources\taobao-reminders-defaults.json" 0 +2
      CopyFiles /SILENT "$INSTDIR\resources\taobao-reminders-defaults.json" "$PLUGINSDIR\prior-reminder-defaults.json"
  !endif
!macroend

!macro customInstall
  ${If} ${FileExists} "$PLUGINSDIR\prior-reminder-defaults.json"
  ${AndIfNot} ${FileExists} "$INSTDIR\resources\taobao-reminders-defaults.json"
    CopyFiles /SILENT "$PLUGINSDIR\prior-reminder-defaults.json" "$INSTDIR\resources\taobao-reminders-defaults.json"
  ${EndIf}
!macroend

; A silent updater must receive the error even when nobody can dismiss a dialog.
!macro toolkitUninstallResult
  ${If} ${Errors}
  ${OrIf} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "旧版工具箱未能卸载，退出码 $R0。请查看 $TEMP\toolkit-install-processes.log。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro toolkitUninstallResult
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro toolkitUninstallResult
!macroend
