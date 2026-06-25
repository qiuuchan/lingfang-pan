//! 交互卸载模式（egui 确认，design §4）。UI 用 theme 模块统一风格。
//!
//! 流程：确认 → 关主进程 → 删快捷方式 → 删注册表 → 删安装目录 → 自删除。

use anyhow::Result;

use crate::paths;
use crate::platform;
use crate::theme;

enum Phase {
    Confirm,
    Done,
    Failed(String),
}

struct UninstallApp {
    phase: Phase,
}

/// 启动交互卸载窗口。
pub fn run_interactive() -> Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([520.0, 360.0])
            .with_resizable(false)
            .with_maximize_button(false),
        ..Default::default()
    };
    eframe::run_native(
        &format!("卸载 {}", paths::DISPLAY_NAME),
        options,
        Box::new(|cc| {
            theme::install_fonts(&cc.egui_ctx);
            theme::apply_style(&cc.egui_ctx);
            Ok(Box::new(UninstallApp { phase: Phase::Confirm }))
        }),
    )
    .map_err(|e| anyhow::anyhow!("启动卸载界面失败：{e}"))?;
    Ok(())
}

impl eframe::App for UninstallApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::TopBottomPanel::top("header")
            .frame(egui::Frame::none())
            .show_separator_line(false)
            .show(ctx, |ui| {
                theme::header(ui, paths::DISPLAY_NAME, "卸载向导");
            });

        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(theme::BG).inner_margin(egui::Margin::same(24.0)))
            .show(ctx, |ui| match &self.phase {
                Phase::Confirm => {
                    theme::card(ui, |ui| {
                        ui.label(egui::RichText::new("确认卸载").size(16.0).strong());
                        ui.add_space(8.0);
                        ui.label(
                            egui::RichText::new("将删除程序文件、开始菜单与桌面快捷方式，以及注册表登记项。此操作不可恢复。")
                                .size(13.0)
                                .color(theme::TEXT_MUTED),
                        );
                    });
                    ui.add_space(20.0);
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if theme::danger_button(ui, "确认卸载") {
                            self.phase = match do_uninstall() {
                                Ok(()) => Phase::Done,
                                Err(e) => Phase::Failed(format!("{e:#}")),
                            };
                        }
                        if theme::secondary_button(ui, "取消") {
                            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                        }
                    });
                }
                Phase::Done => {
                    theme::card(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(egui::RichText::new("✓").size(24.0).color(theme::SUCCESS).strong());
                            ui.add_space(4.0);
                            ui.label(egui::RichText::new("已卸载完成").size(16.0).strong());
                        });
                    });
                    ui.add_space(20.0);
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if theme::primary_button(ui, "完成") {
                            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                        }
                    });
                }
                Phase::Failed(e) => {
                    let e = e.clone();
                    theme::card(ui, |ui| {
                        ui.label(egui::RichText::new("✕ 卸载出错").size(16.0).color(theme::DANGER).strong());
                        ui.add_space(8.0);
                        ui.label(egui::RichText::new(&e).size(13.0).color(theme::TEXT));
                    });
                    ui.add_space(20.0);
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if theme::secondary_button(ui, "关闭") {
                            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                        }
                    });
                }
            });
    }
}

/// 卸载步骤。
fn do_uninstall() -> Result<()> {
    let install_dir = paths::default_install_dir()?;

    // 1) 关闭运行中的主进程。
    let killed = platform::kill_by_name(paths::MAIN_EXE);
    crate::log_line(&format!("卸载：终止 {killed} 个主进程"));

    // 2) 删快捷方式。
    if let Some(appdata) = dirs::data_dir() {
        let start_menu = appdata
            .join("Microsoft\\Windows\\Start Menu\\Programs")
            .join(format!("{}.lnk", paths::DISPLAY_NAME));
        let _ = std::fs::remove_file(&start_menu);
    }
    if let Some(desktop) = dirs::desktop_dir() {
        let lnk = desktop.join(format!("{}.lnk", paths::DISPLAY_NAME));
        let _ = std::fs::remove_file(&lnk);
    }

    // 3) 删注册表 Uninstall key。
    platform::delete_uninstall_key()?;

    // 4) 删安装目录文件。updater.exe（本进程）正在运行无法删自身，
    //    先删其余文件，再计划自删除 updater.exe + 目录。
    let self_exe = std::env::current_exe().ok();
    remove_dir_except(&install_dir, self_exe.as_deref());

    // 5) 计划自删除：删 updater.exe 自身（延迟到进程退出后）。
    if let Some(exe) = self_exe {
        platform::schedule_self_delete(&exe);
    }

    Ok(())
}

/// 删除目录下所有文件/子目录，except 指定的文件（正在运行的 updater.exe）。
fn remove_dir_except(dir: &std::path::Path, except: Option<&std::path::Path>) {
    let except_canon = except.and_then(|p| p.canonicalize().ok());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let is_except = except_canon
                .as_ref()
                .and_then(|e| path.canonicalize().ok().map(|p| &p == e))
                .unwrap_or(false);
            if !is_except {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}
