//! 交互安装模式（egui，design §4）。
//!
//! 流程：确认目录 → 解压 → 快捷方式 → 注册表 → 完成。UI 用 theme 模块统一风格。

use std::path::PathBuf;
use std::sync::mpsc;

use anyhow::Result;

use crate::modes::deploy;
use crate::paths;
use crate::platform;
use crate::theme;

/// 后台安装线程发给 UI 的消息。
enum Progress {
    /// 阶段文字 + 进度比例（0.0~1.0）。
    Step(String, f32),
    /// 完成。
    Done,
    /// 失败。
    Failed(String),
}

/// UI 当前阶段。
enum Phase {
    Confirm,
    Installing { status: String, frac: f32 },
    Done,
    Failed(String),
}

struct InstallerApp {
    install_dir: String,
    version: String,
    phase: Phase,
    create_desktop: bool,
    rx: Option<mpsc::Receiver<Progress>>,
}

/// 启动交互安装窗口。
pub fn run_interactive(target: Option<&str>) -> Result<()> {
    let install_dir = paths::resolve_install_dir(target)?
        .to_string_lossy()
        .to_string();
    let app = InstallerApp {
        install_dir,
        version: env!("CARGO_PKG_VERSION").to_string(),
        phase: Phase::Confirm,
        create_desktop: true,
        rx: None,
    };

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([560.0, 440.0])
            .with_resizable(false)
            .with_maximize_button(false),
        ..Default::default()
    };
    eframe::run_native(
        &format!("{} 安装程序", paths::DISPLAY_NAME),
        options,
        Box::new(|cc| {
            theme::install_fonts(&cc.egui_ctx);
            theme::apply_style(&cc.egui_ctx);
            Ok(Box::new(app))
        }),
    )
    .map_err(|e| anyhow::anyhow!("启动安装界面失败：{e}"))?;
    Ok(())
}

impl eframe::App for InstallerApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // 接收后台安装进度。
        if let Some(rx) = &self.rx {
            while let Ok(msg) = rx.try_recv() {
                match msg {
                    Progress::Step(s, f) => self.phase = Phase::Installing { status: s, frac: f },
                    Progress::Done => {
                        self.phase = Phase::Done;
                        self.rx = None;
                        break;
                    }
                    Progress::Failed(e) => {
                        self.phase = Phase::Failed(e);
                        self.rx = None;
                        break;
                    }
                }
            }
            ctx.request_repaint();
        }

        // 顶部品牌横幅（占满宽度，无内边距）。
        egui::TopBottomPanel::top("header")
            .frame(egui::Frame::none())
            .show_separator_line(false)
            .show(ctx, |ui| {
                theme::header(ui, paths::DISPLAY_NAME, &format!("版本 {}  ·  安装向导", self.version));
            });

        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(theme::BG).inner_margin(egui::Margin::same(24.0)))
            .show(ctx, |ui| {
                match &self.phase {
                    Phase::Confirm => self.view_confirm(ui),
                    Phase::Installing { status, frac } => {
                        let (s, f) = (status.clone(), *frac);
                        view_installing(ui, &s, f);
                    }
                    Phase::Done => self.view_done(ui, ctx),
                    Phase::Failed(e) => {
                        let e = e.clone();
                        view_failed(ui, ctx, &e);
                    }
                }
            });
    }
}

impl InstallerApp {
    fn view_confirm(&mut self, ui: &mut egui::Ui) {
        theme::card(ui, |ui| {
            ui.label(egui::RichText::new("安装位置").size(14.0).strong());
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut self.install_dir)
                        .desired_width(ui.available_width() - 96.0)
                        .margin(egui::Margin::symmetric(10.0, 8.0)),
                );
                if theme::secondary_button(ui, "浏览…") {
                    if let Some(picked) = pick_folder(&self.install_dir) {
                        self.install_dir = picked;
                    }
                }
            });
            ui.add_space(4.0);
            ui.label(
                egui::RichText::new("将安装主程序、内置运行时与插件到上述目录。")
                    .size(12.5)
                    .color(theme::TEXT_MUTED),
            );
            ui.add_space(14.0);
            ui.separator();
            ui.add_space(10.0);
            ui.checkbox(&mut self.create_desktop, "创建桌面快捷方式");
        });

        ui.add_space(20.0);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if theme::primary_button(ui, "开始安装") {
                self.start_install();
            }
        });
    }

    fn view_done(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        theme::card(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("✓").size(26.0).color(theme::SUCCESS).strong());
                ui.add_space(4.0);
                ui.vertical(|ui| {
                    ui.label(egui::RichText::new("安装完成").size(17.0).strong());
                    ui.label(
                        egui::RichText::new("已添加开始菜单快捷方式，可随时从控制面板卸载。")
                            .size(12.5)
                            .color(theme::TEXT_MUTED),
                    );
                });
            });
        });
        ui.add_space(20.0);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if theme::primary_button(ui, "立即启动") {
                let main = PathBuf::from(&self.install_dir).join(paths::MAIN_EXE);
                let _ = std::process::Command::new(main).spawn();
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
            if theme::secondary_button(ui, "完成") {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
        });
    }

    fn start_install(&mut self) {
        self.phase = Phase::Installing { status: "准备中…".into(), frac: 0.0 };
        let dir = PathBuf::from(&self.install_dir);
        let version = self.version.clone();
        let create_desktop = self.create_desktop;
        let (tx, rx) = mpsc::channel();
        self.rx = Some(rx);

        std::thread::spawn(move || {
            let result = do_install(&dir, &version, create_desktop, &tx);
            match result {
                Ok(()) => {
                    let _ = tx.send(Progress::Done);
                }
                Err(e) => {
                    let _ = tx.send(Progress::Failed(format!("{e:#}")));
                }
            }
        });
    }
}

fn view_installing(ui: &mut egui::Ui, status: &str, frac: f32) {
    theme::card(ui, |ui| {
        ui.label(egui::RichText::new("正在安装").size(16.0).strong());
        ui.add_space(4.0);
        ui.label(egui::RichText::new(status).size(13.0).color(theme::TEXT_MUTED));
        ui.add_space(14.0);
        ui.add(
            egui::ProgressBar::new(frac)
                .desired_height(10.0)
                .fill(theme::BRAND)
                .animate(true),
        );
        ui.add_space(4.0);
        ui.label(
            egui::RichText::new(format!("{}%", (frac * 100.0) as u32))
                .size(12.0)
                .color(theme::TEXT_MUTED),
        );
    });
}

fn view_failed(ui: &mut egui::Ui, ctx: &egui::Context, err: &str) {
    theme::card(ui, |ui| {
        ui.label(egui::RichText::new("✕ 安装失败").size(16.0).color(theme::DANGER).strong());
        ui.add_space(8.0);
        ui.label(egui::RichText::new(err).size(13.0).color(theme::TEXT));
    });
    ui.add_space(20.0);
    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
        if theme::secondary_button(ui, "关闭") {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
    });
}

/// 调系统文件夹选择对话框（PowerShell，避免引入额外 crate）。返回所选路径或 None。
fn pick_folder(current: &str) -> Option<String> {
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
         $d.SelectedPath = '{}'; \
         if ($d.ShowDialog() -eq 'OK') {{ Write-Output $d.SelectedPath }}",
        current.replace('\'', "''")
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-STA", "-Command", &script])
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        // 选中的是父目录时附加应用名（让用户选「装到哪个文件夹下」）。
        let p = PathBuf::from(&path);
        if p.file_name().map(|n| n == paths::INSTALL_DIR_NAME).unwrap_or(false) {
            Some(path)
        } else {
            Some(p.join(paths::INSTALL_DIR_NAME).to_string_lossy().to_string())
        }
    }
}

/// 实际安装步骤（后台线程执行，通过 tx 推进度）。
fn do_install(
    dir: &std::path::Path,
    version: &str,
    create_desktop: bool,
    tx: &mpsc::Sender<Progress>,
) -> Result<()> {
    let _ = tx.send(Progress::Step("正在解压程序文件…".into(), 0.15));
    deploy::deploy_to(dir)?;

    let main_exe = dir.join(paths::MAIN_EXE);
    let icon = dir.join("icons").join("icon.ico");
    let icon = if icon.exists() { icon } else { main_exe.clone() };

    let _ = tx.send(Progress::Step("正在创建快捷方式…".into(), 0.7));
    if let Some(appdata) = dirs::data_dir() {
        let start_menu = appdata
            .join("Microsoft\\Windows\\Start Menu\\Programs")
            .join(format!("{}.lnk", paths::DISPLAY_NAME));
        platform::create_shortcut(&start_menu, &main_exe, dir, &icon)?;
    }
    if create_desktop {
        if let Some(desktop) = dirs::desktop_dir() {
            let lnk = desktop.join(format!("{}.lnk", paths::DISPLAY_NAME));
            platform::create_shortcut(&lnk, &main_exe, dir, &icon)?;
        }
    }

    let _ = tx.send(Progress::Step("正在写入注册表…".into(), 0.9));
    let size_kb = deploy::dir_size_kb(dir);
    platform::write_uninstall_key(dir, version, size_kb)?;

    let _ = tx.send(Progress::Step("完成收尾…".into(), 1.0));
    Ok(())
}
