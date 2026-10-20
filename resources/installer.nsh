# Keep the installation progress window alive after Electron exits. These hooks
# change only --updated installs; first-time setup retains the normal wizard.

!macro customHeader
!ifndef BUILD_UNINSTALLER
  LangString NekoUpdateTitle ${LANG_ENGLISH} "Installing update"
  LangString NekoUpdateTitle ${LANG_SIMPCHINESE} "正在安装更新"
  LangString NekoUpdateTitle ${LANG_TRADCHINESE} "正在安裝更新"
  LangString NekoUpdateDescription ${LANG_ENGLISH} "Please wait. NekoCode Desktop will reopen automatically when the update is complete."
  LangString NekoUpdateDescription ${LANG_SIMPCHINESE} "请稍候，NekoCode Desktop 将在更新完成后自动重新打开。"
  LangString NekoUpdateDescription ${LANG_TRADCHINESE} "請稍候，NekoCode Desktop 將在更新完成後自動重新開啟。"

  Function NekoInstallFilesPre
    # The normal directory sanitizer may append the product name. An update
    # must preserve even a custom directory whose name differs from the app.
    ${ifNot} ${isUpdated}
      !ifdef allowToChangeInstallationDirectory
        Call instFilesPre
      !endif
    ${endif}
  FunctionEnd

  Function NekoUpdateProgress
    ${if} ${isUpdated}
      !insertmacro MUI_HEADER_TEXT "$(NekoUpdateTitle)" "$(NekoUpdateDescription)"
    ${endif}
  FunctionEnd

  Function NekoFinishPagePre
    ${if} ${isUpdated}
      Abort
    ${endif}
  FunctionEnd

  Function NekoStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
!endif
!macroend

!macro customInit
  ${if} ${isUpdated}
    ${if} ${isForceRun}
      # Older clients send /S for the explicit restart action. Promote only
      # that path; background install-on-quit has no --force-run and stays silent.
      SetSilent normal
    ${endif}
    SetAutoClose true
  ${endif}
!macroend

!macro customInstallMode
!ifndef BUILD_UNINSTALLER
  ${if} ${isUpdated}
    # initMultiUser has resolved the existing installation's scope and path.
    ${if} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!endif
!macroend

!macro customPageAfterChangeDir
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE NekoInstallFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW NekoUpdateProgress
!macroend

!macro customInstall
  ${if} ${isUpdated}
  ${andIf} ${isForceRun}
  ${andIfNot} ${Silent}
    # Silent updates already restart through electron-builder's install section.
    Call NekoStartApp
  ${endif}
!macroend

!macro customFinishPage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE NekoFinishPagePre
  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION NekoStartApp
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend

