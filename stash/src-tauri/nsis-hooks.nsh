; 安装器钩子（tauri.conf.json → bundle.windows.nsis.installerHooks）。
;
; Tauri 默认把卸载项写成 InstallLocation = "C:\...\Stash"（带引号），
; 部分启动器 / 卸载工具会把它当字面量，路径解析失败。
; 安装完成后按原键名重写一次，去掉引号。
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
!macroend
