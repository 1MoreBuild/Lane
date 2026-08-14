!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\works.earendil.lane"
  Delete "$LOCALAPPDATA\Lane\NativeMessagingHosts\works.earendil.lane.json"
  RMDir "$LOCALAPPDATA\Lane\NativeMessagingHosts"

  ${ifNot} ${isUpdated}
    ClearErrors
    FileOpen $0 "$LOCALAPPDATA\Microsoft\WindowsApps\lane.cmd" r
    IfErrors lane_cli_cleanup_done
    FileRead $0 $1
    FileClose $0
    StrCmp $1 "@rem Lane CLI launcher v1$\r$\n" 0 lane_cli_cleanup_done
    Delete "$LOCALAPPDATA\Microsoft\WindowsApps\lane.cmd"
    lane_cli_cleanup_done:
  ${endIf}
!macroend
