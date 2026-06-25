//! 安装器/卸载器统一视觉主题（参考 VS Code / Discord 安装器风格）。
//!
//! 提供品牌色、egui Style 配置、可复用的头部品牌横幅与按钮，让 install/uninstall 两个
//! 窗口观感一致、现代。无额外依赖（纯 egui 绘制，不引图片解码）。egui 0.28 API。

use egui::{Color32, FontId, Margin, RichText, Rounding, Stroke, Vec2};

/// 品牌主色（靛蓝，主按钮/强调）。
pub const BRAND: Color32 = Color32::from_rgb(99, 102, 241);
/// 品牌深色（头部横幅渐变底/悬停）。
pub const BRAND_DARK: Color32 = Color32::from_rgb(67, 56, 202);
/// 成功色（完成态）。
pub const SUCCESS: Color32 = Color32::from_rgb(34, 197, 94);
/// 危险色（错误/卸载强调）。
pub const DANGER: Color32 = Color32::from_rgb(239, 68, 68);
/// 窗口主背景（接近纯白的浅灰）。
pub const BG: Color32 = Color32::from_rgb(249, 250, 251);
/// 卡片背景（纯白）。
pub const CARD: Color32 = Color32::from_rgb(255, 255, 255);
/// 主文字色（近黑）。
pub const TEXT: Color32 = Color32::from_rgb(17, 24, 39);
/// 次要文字色（灰）。
pub const TEXT_MUTED: Color32 = Color32::from_rgb(107, 114, 128);
/// 边框色（浅灰）。
pub const BORDER: Color32 = Color32::from_rgb(229, 231, 235);

/// 应用整体 egui 风格（浅色、圆角、留白）。
pub fn apply_style(ctx: &egui::Context) {
    let mut style = (*ctx.style()).clone();

    style.visuals = egui::Visuals::light();
    style.visuals.panel_fill = BG;
    style.visuals.window_fill = BG;
    style.visuals.override_text_color = Some(TEXT);
    style.visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, BORDER);
    style.visuals.widgets.inactive.rounding = Rounding::same(8.0);
    style.visuals.widgets.hovered.rounding = Rounding::same(8.0);
    style.visuals.widgets.active.rounding = Rounding::same(8.0);
    style.visuals.selection.bg_fill = BRAND;
    style.visuals.selection.stroke = Stroke::new(1.0, BRAND);

    // 统一字号（CJK 字体在 install_fonts 中注入）。
    use egui::TextStyle::*;
    style.text_styles = [
        (Heading, FontId::proportional(22.0)),
        (Body, FontId::proportional(15.0)),
        (Button, FontId::proportional(15.0)),
        (Small, FontId::proportional(12.5)),
        (Monospace, FontId::monospace(13.0)),
    ]
    .into();

    style.spacing.button_padding = Vec2::new(16.0, 8.0);
    style.spacing.item_spacing = Vec2::new(10.0, 10.0);

    ctx.set_style(style);
}

/// 加载系统中文字体（egui 默认字体不含 CJK，否则显示方框）。
pub fn install_fonts(ctx: &egui::Context) {
    let candidates = [
        "C:\\Windows\\Fonts\\msyh.ttc",   // 微软雅黑
        "C:\\Windows\\Fonts\\msyhl.ttc",  // 微软雅黑 Light
        "C:\\Windows\\Fonts\\simhei.ttf", // 黑体
        "C:\\Windows\\Fonts\\simsun.ttc", // 宋体
    ];
    for path in candidates {
        if let Ok(bytes) = std::fs::read(path) {
            let mut fonts = egui::FontDefinitions::default();
            fonts
                .font_data
                .insert("cjk".to_owned(), egui::FontData::from_owned(bytes));
            fonts
                .families
                .entry(egui::FontFamily::Proportional)
                .or_default()
                .insert(0, "cjk".to_owned());
            fonts
                .families
                .entry(egui::FontFamily::Monospace)
                .or_default()
                .push("cjk".to_owned());
            ctx.set_fonts(fonts);
            return;
        }
    }
}

/// 绘制顶部品牌横幅（深色底 + logo 徽章 + 标题/副标题）。
///
/// `subtitle` 形如 "v0.0.6" 或 "卸载向导"。
pub fn header(ui: &mut egui::Ui, title: &str, subtitle: &str) {
    let banner_h = 96.0;
    let full_w = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(Vec2::new(full_w, banner_h), egui::Sense::hover());
    let painter = ui.painter();

    // 横幅底色（自上而下两段近似渐变）。
    painter.rect_filled(rect, Rounding::ZERO, BRAND_DARK);
    let upper = egui::Rect::from_min_max(rect.min, egui::pos2(rect.max.x, rect.center().y));
    painter.rect_filled(upper, Rounding::ZERO, BRAND);

    // logo 徽章：圆角方块 + 首字。
    let badge = egui::Rect::from_center_size(
        egui::pos2(rect.min.x + 56.0, rect.center().y),
        Vec2::splat(52.0),
    );
    painter.rect_filled(badge, Rounding::same(14.0), Color32::from_white_alpha(40));
    painter.rect_stroke(
        badge,
        Rounding::same(14.0),
        Stroke::new(1.5, Color32::from_white_alpha(90)),
    );
    painter.text(
        badge.center(),
        egui::Align2::CENTER_CENTER,
        "灵",
        FontId::proportional(28.0),
        Color32::WHITE,
    );

    // 标题 + 副标题。
    let text_x = rect.min.x + 96.0;
    painter.text(
        egui::pos2(text_x, rect.center().y - 12.0),
        egui::Align2::LEFT_CENTER,
        title,
        FontId::proportional(22.0),
        Color32::WHITE,
    );
    painter.text(
        egui::pos2(text_x, rect.center().y + 16.0),
        egui::Align2::LEFT_CENTER,
        subtitle,
        FontId::proportional(13.5),
        Color32::from_white_alpha(210),
    );
}

/// 主行动按钮（品牌色填充，大号）。返回是否被点击。
pub fn primary_button(ui: &mut egui::Ui, text: &str) -> bool {
    let btn = egui::Button::new(RichText::new(text).color(Color32::WHITE).size(15.0))
        .fill(BRAND)
        .rounding(Rounding::same(8.0))
        .min_size(Vec2::new(120.0, 40.0));
    ui.add(btn).clicked()
}

/// 次要按钮（描边，中性）。返回是否被点击。
pub fn secondary_button(ui: &mut egui::Ui, text: &str) -> bool {
    let btn = egui::Button::new(RichText::new(text).color(TEXT).size(15.0))
        .fill(CARD)
        .stroke(Stroke::new(1.0, BORDER))
        .rounding(Rounding::same(8.0))
        .min_size(Vec2::new(96.0, 40.0));
    ui.add(btn).clicked()
}

/// 危险按钮（红色填充）。返回是否被点击。
pub fn danger_button(ui: &mut egui::Ui, text: &str) -> bool {
    let btn = egui::Button::new(RichText::new(text).color(Color32::WHITE).size(15.0))
        .fill(DANGER)
        .rounding(Rounding::same(8.0))
        .min_size(Vec2::new(120.0, 40.0));
    ui.add(btn).clicked()
}

/// 在卡片容器中渲染内容（白底圆角 + 细边框 + 内边距）。
pub fn card<R>(ui: &mut egui::Ui, add_contents: impl FnOnce(&mut egui::Ui) -> R) -> R {
    egui::Frame::none()
        .fill(CARD)
        .stroke(Stroke::new(1.0, BORDER))
        .rounding(Rounding::same(12.0))
        .inner_margin(Margin::same(18.0))
        .show(ui, add_contents)
        .inner
}
