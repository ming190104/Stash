fn main() {
    // 图标改了必须重跑本脚本，否则 resource.lib 里还是旧图标（exe / 快捷方式 / 任务栏全都不更新）
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
