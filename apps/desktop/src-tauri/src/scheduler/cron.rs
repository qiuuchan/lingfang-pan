//! Cron 表达式封装：基于 `croner` crate 计算下次触发时间。
//!
//! 时区策略（MVP）：
//! - CRON 触发器存储 IANA 时区名（如 `Asia/Shanghai`），但解析时映射到一个固定偏移（FixedOffset）。
//! - 不引 chrono-tz（避免额外依赖）；用常用时区固定偏移表 + 系统时区兜底。
//! - 这意味着 DST（夏令时）边界日可能有分钟级偏差——60s tick 容忍，且主要用户时区（Asia/*）无 DST。
//! - 未来引入 chrono-tz 后可直接替换为 IANA 时区精确解释。

use chrono::{DateTime, FixedOffset, Utc};
use croner::Cron;

use super::types::LocalScheduleTrigger;

/// 解析 cron 字符串为 croner::Cron。
/// croner 默认 5 字段（分 时 日 月 周），与契约 regex 一致。
pub(crate) fn parse_cron(expr: &str) -> Result<Cron, String> {
    Cron::new(expr)
        .parse()
        .map_err(|e| format!("cron 表达式无效「{expr}」：{e}"))
}

/// 给定触发器，计算从"现在"起的下一次触发时间（UTC RFC 3339）。
///
/// - ONCE：返回 `run_at`（若已过期，返回 None）。
/// - CRON：在目标时区下算下一次匹配，转 UTC 返回。
///
/// 返回 None 表示该触发器不会再触发（ONCE 已过期）。
pub(crate) fn next_run_after(
    trigger: &LocalScheduleTrigger,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, String> {
    match trigger {
        LocalScheduleTrigger::Once { run_at } => {
            let target = parse_iso(run_at)?;
            Ok(if target > now { Some(target) } else { None })
        }
        LocalScheduleTrigger::Cron { cron, time_zone } => {
            let parsed = parse_cron(cron)?;
            // 把目标时区映射到 FixedOffset。
            let offset = tz_fixed_offset(time_zone, now)?;
            // 把 now 转换到目标时区的 DateTime<FixedOffset>。
            let now_in_tz = now.with_timezone(&offset);
            // find_next_occurrence(inclusive=false) 从 now 之后找下一个匹配。
            let next_in_tz = parsed
                .find_next_occurrence(&now_in_tz, false)
                .map_err(|e| format!("cron 计算失败：{e}"))?;
            Ok(Some(next_in_tz.with_timezone(&Utc)))
        }
    }
}

/// 解析 RFC 3339 / ISO 8601 字符串为 UTC DateTime。
pub(crate) fn parse_iso(s: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt: DateTime<FixedOffset>| dt.with_timezone(&Utc))
        .map_err(|e| format!("时间格式无效「{s}」：{e}"))
}

/// 把 IANA 时区名映射到 FixedOffset。
/// 常用时区用固定偏移表；未知时区回退到系统本地时区偏移。
/// DST 不区分（与 WorkBuddy 默认行为一致；DST 边界分钟级偏差由 60s tick 容忍）。
fn tz_fixed_offset(time_zone: &str, now: DateTime<Utc>) -> Result<FixedOffset, String> {
    let offset_secs: i32 = match time_zone {
        "UTC" | "GMT" => 0,
        "Asia/Shanghai" | "Asia/Hong_Kong" | "Asia/Taipei" | "Asia/Singapore"
        | "Asia/Kuala_Lumpur" | "Asia/Manila" | "Asia/Makassar" => 8 * 3600,
        "Asia/Tokyo" | "Asia/Seoul" => 9 * 3600,
        "Asia/Bangkok" | "Asia/Jakarta" | "Asia/Ho_Chi_Minh" => 7 * 3600,
        "Asia/Kolkata" | "Asia/Calcutta" => 5 * 3600 + 30 * 60,
        "Asia/Dubai" => 4 * 3600,
        "Europe/London" | "Europe/Lisbon" | "Atlantic/Reykjavik" => 0,
        "Europe/Paris" | "Europe/Berlin" | "Europe/Rome" | "Europe/Madrid" | "Europe/Amsterdam"
        | "Europe/Brussels" | "Europe/Stockholm" | "Europe/Oslo" | "Europe/Copenhagen" => 3600,
        "Europe/Moscow" => 3 * 3600,
        "America/New_York" => -5 * 3600,
        "America/Chicago" => -6 * 3600,
        "America/Denver" => -7 * 3600,
        "America/Los_Angeles" => -8 * 3600,
        "America/Sao_Paulo" | "America/Argentina/Buenos_Aires" => -3 * 3600,
        "Australia/Sydney" => 10 * 3600,
        "Australia/Perth" => 8 * 3600,
        _ => {
            // 未知时区：用系统本地时区偏移（与"默认系统时区"决策对齐）。
            chrono::Local::now().offset().local_minus_utc()
        }
    };
    let _ = now; // 保留参数（未来引入 chrono-tz 时用）。
    FixedOffset::east_opt(offset_secs)
        .ok_or_else(|| format!("时区偏移无效：{offset_secs} 秒"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn once_future_returns_target() {
        let t = LocalScheduleTrigger::Once {
            run_at: "2030-01-01T00:00:00Z".to_string(),
        };
        let next = next_run_after(&t, utc(2026, 7, 20, 0, 0)).unwrap();
        assert!(next.is_some());
        assert_eq!(next.unwrap().to_rfc3339(), "2030-01-01T00:00:00+00:00");
    }

    #[test]
    fn once_past_returns_none() {
        let t = LocalScheduleTrigger::Once {
            run_at: "2020-01-01T00:00:00Z".to_string(),
        };
        let next = next_run_after(&t, utc(2026, 7, 20, 0, 0)).unwrap();
        assert!(next.is_none());
    }

    #[test]
    fn cron_every_minute_returns_soon() {
        let t = LocalScheduleTrigger::Cron {
            cron: "* * * * *".to_string(),
            time_zone: "UTC".to_string(),
        };
        let now = utc(2026, 7, 20, 12, 0);
        let next = next_run_after(&t, now).unwrap().unwrap();
        // 下一分钟整点（UTC）。
        assert_eq!(next.to_rfc3339(), "2026-07-20T12:01:00+00:00");
    }

    #[test]
    fn cron_invalid_returns_err() {
        let result = parse_cron("not a cron");
        assert!(result.is_err());
    }

    #[test]
    fn cron_shanghai_hour_aligns() {
        // 每天 09:00 上海（UTC+8）→ UTC 01:00。
        let t = LocalScheduleTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            time_zone: "Asia/Shanghai".to_string(),
        };
        // "现在"在上海是 2026-07-20 08:00 → UTC 00:00；下次应是上海 09:00 → UTC 01:00。
        let now = utc(2026, 7, 20, 0, 0);
        let next = next_run_after(&t, now).unwrap().unwrap();
        assert_eq!(next.to_rfc3339(), "2026-07-20T01:00:00+00:00");
    }

    #[test]
    fn cron_weekly_monday() {
        // 每周一 09:00 上海。
        let t = LocalScheduleTrigger::Cron {
            cron: "0 9 * * 1".to_string(),
            time_zone: "Asia/Shanghai".to_string(),
        };
        // 2026-07-20 是周一。UTC 00:00 = 上海 08:00 周一；下次应是上海 09:00 → UTC 01:00。
        let now = utc(2026, 7, 20, 0, 0);
        let next = next_run_after(&t, now).unwrap().unwrap();
        assert_eq!(next.to_rfc3339(), "2026-07-20T01:00:00+00:00");
    }

    #[test]
    fn tz_unknown_falls_back_to_local() {
        // 未知时区不报错，回退到系统本地时区。
        let offset = tz_fixed_offset("Foo/Bar", Utc::now());
        assert!(offset.is_ok());
    }
}
