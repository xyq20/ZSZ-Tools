!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop-toolkit-processes.ps1 "${BUILD_RESOURCES_DIR}\stop-toolkit-processes.ps1"
  DetailPrint "正在停止工具箱相关进程，请稍候…"
  ReadRegStr $R3 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R4 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  toolkit_process_retry:
  nsExec::ExecToStack /TIMEOUT=90000 '"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-toolkit-processes.ps1" -InstallDir "$INSTDIR\." -PreviousUserDir "$R3\." -PreviousMachineDir "$R4\." -LogPath "$TEMP\toolkit-install-processes.log"'
  Pop $R0
  Pop $R1
  DetailPrint "$R1"
  ${If} $R0 != 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "未能停止全部工具箱进程，安装已暂停。请以管理员身份重试。日志：$TEMP\toolkit-install-processes.log" /SD IDCANCEL IDRETRY toolkit_process_retry
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
