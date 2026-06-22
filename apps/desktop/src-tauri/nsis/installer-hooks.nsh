; 项 1：强制安装目录保留旧 "LingFang" 路径。
;
; 背景：productName 已从 "LingFang" 改为 "灵坊"（显示名）。Tauri NSIS currentUser 模式下
; 默认 InstallDir = "$LOCALAPPDATA\<productName>"，改名后会变成 "$LOCALAPPDATA\灵坊"，
; 导致已安装旧版（LingFang/）的用户无法原地升级（会装到新目录，出现两个安装）。
;
; 修复：在 installerHooks 里重新声明 InstallDir 为旧 "LingFang" 路径。NSIS 以「最后一条
; InstallDir 定义」为准，本 hook 在 Tauri 模板默认 InstallDir 之后被 !include，覆盖之。
; 同时 productName="灵坊" 不变（开始菜单/添加删除程序/exe 仍显示「灵坊」）。
;
; 验证：装机后检查安装目录是否为 %LOCALAPPDATA%\LingFang（需在实际机器跑安装包确认）。
InstallDir "$LOCALAPPDATA\LingFang"
