//! JavaScript semantics the budget, recurring and bulk services depend on:
//! calendar arithmetic through `Date` (including the 0–99 → 1900s year
//! mapping), the `@openfinance/shared` date helpers, number formatting,
//! `Math.round`, `toFixed` and `parseFloat`.

use chrono::{Datelike, Local};

use crate::js::is_js_whitespace;

/// `localIsoDate()`: the local calendar day as `YYYY-MM-DD` (year unpadded,
/// like `getFullYear()`).
pub(crate) fn local_iso_date() -> String {
    let d = Local::now().date_naive();
    format!("{}-{:02}-{:02}", d.year(), d.month(), d.day())
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The calendar date `new Date(y, m0, d)` (local) or `Date.UTC(y, m0, d)`
/// lands on, as `(year, month 1-12, day)`. Years 0–99 mean 1900–1999, months
/// and days overflow, and anything outside the `Date` range is `None`
/// (Invalid Date).
pub(crate) fn js_make_date(y: f64, m0: f64, d: f64) -> Option<(i64, i64, i64)> {
    if !(y.is_finite() && m0.is_finite() && d.is_finite()) {
        return None;
    }
    let yi = y.trunc();
    let year = if (0.0..=99.0).contains(&yi) {
        1900.0 + yi
    } else {
        yi
    };
    let (m0, d) = (m0.trunc(), d.trunc());
    if year.abs() > 1e9 || m0.abs() > 1e12 || d.abs() > 1e12 {
        return None;
    }
    let (year, m0, d) = (year as i64, m0 as i64, d as i64);
    let ym = year.checked_add(m0.div_euclid(12))?;
    if ym.abs() > 1_000_000 {
        return None;
    }
    let day = days_from_civil(ym, m0.rem_euclid(12) + 1, 1).checked_add(d - 1)?;
    // TimeClip: |t| <= 8.64e15 ms, i.e. 1e8 days either side of the epoch.
    if day.abs() > 100_000_000 {
        return None;
    }
    Some(civil_from_days(day))
}

/// `new Date(year, month, 0).getDate()` / `daysInMonth(year, month)`: the
/// last day of 1-based `month` (NaN for an invalid date).
pub(crate) fn last_day_of_month(year: f64, month: f64) -> f64 {
    js_make_date(year, month, 0.0).map_or(f64::NAN, |(_, _, d)| d as f64)
}

/// `"YYYY-MM".split("-").map(Number)` destructured into `[year, mon]`.
pub(crate) fn split_numbers(s: &str, n: usize) -> Vec<f64> {
    let mut parts: Vec<f64> = s
        .split('-')
        .take(n)
        .map(crate::json::string_to_number)
        .collect();
    parts.resize(n, f64::NAN);
    parts
}

/// `` `${month}-${String(new Date(year, mon, 0).getDate()).padStart(2, "0")}` ``:
/// the last calendar day of a `YYYY-MM` month.
pub(crate) fn month_end(month: &str) -> String {
    let p = split_numbers(month, 2);
    format!("{month}-{}", pad2(last_day_of_month(p[0], p[1])))
}

/// `iso.slice(0, 10)` (UTF-16 units; ASCII dates are unaffected).
fn slice10(iso: &str) -> String {
    let units: Vec<u16> = iso.encode_utf16().take(10).collect();
    String::from_utf16_lossy(&units)
}

/// `splitIso(iso)`.
fn split_iso(iso: &str) -> [f64; 3] {
    let p = split_numbers(&slice10(iso), 3);
    [p[0], p[1], p[2]]
}

/// `dayOfMonth(iso)`.
pub(crate) fn day_of_month(iso: &str) -> f64 {
    split_iso(iso)[2]
}

/// JS `%` (sign of the dividend).
fn js_rem(a: f64, b: f64) -> f64 {
    a % b
}

/// `Math.min(a, b)`: NaN wins.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// `addMonthsIso(iso, months, anchorDay)`.
pub(crate) fn add_months_iso(iso: &str, months: f64, anchor_day: Option<f64>) -> String {
    let [y, m, d] = split_iso(iso);
    let total = y * 12.0 + (m - 1.0) + months;
    let ny = (total / 12.0).floor();
    let nm = js_rem(total, 12.0) + 1.0;
    let day = js_min(anchor_day.unwrap_or(d), last_day_of_month(ny, nm));
    format!("{}-{}-{}", js_num(ny), pad2(nm), pad2(day))
}

/// `addDaysIso(iso, days)`.
pub(crate) fn add_days_iso(iso: &str, days: f64) -> String {
    let [y, m, d] = split_iso(iso);
    match js_make_date(y, m - 1.0, d + days) {
        Some((ny, nm, nd)) => format!("{ny}-{nm:02}-{nd:02}"),
        None => "NaN-NaN-NaN".to_string(),
    }
}

/// `new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)` from
/// bulk.service.ts. `None` where `toISOString` throws (Invalid Date).
pub(crate) fn shift_iso_date(iso: &str, days: f64) -> Option<String> {
    let p = split_numbers(iso, 3);
    let (y, m, d) = js_make_date(p[0], p[1] - 1.0, p[2] + days)?;
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{y:06}")
    };
    let full = format!("{year}-{m:02}-{d:02}");
    Some(full.chars().take(10).collect())
}

/// The month before `YYYY-MM`, via `new Date(y, m - 2, 1)` and
/// `getFullYear()`/`getMonth()`.
pub(crate) fn previous_month(month: &str) -> String {
    let p = split_numbers(month, 2);
    match js_make_date(p[0], p[1] - 2.0, 1.0) {
        Some((y, m, _)) => format!("{y}-{m:02}"),
        None => "NaN-NaN".to_string(),
    }
}

/// `String(n).padStart(2, "0")`.
pub(crate) fn pad2(n: f64) -> String {
    let s = js_num(n);
    if s.len() < 2 {
        format!("0{s}")
    } else {
        s
    }
}

/// `String(x)` for a number (Number::toString with radix 10).
pub(crate) fn js_num(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (a, b) = digits.split_at(n as usize);
        format!("{a}.{b}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e >= 0 {
            format!("+{e}")
        } else {
            format!("-{}", -e)
        };
        if k == 1 {
            format!("{digits}e{es}")
        } else {
            let (a, b) = digits.split_at(1);
            format!("{a}.{b}e{es}")
        }
    };
    format!("{sign}{body}")
}

/// `Math.round(x)`: halves round towards +Infinity; -0 is kept.
pub(crate) fn js_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    if x > 0.0 && x < 0.5 {
        return 0.0;
    }
    if (-0.5..0.0).contains(&x) {
        return -0.0;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `x.toFixed(digits)` for `x` below 1e21: the exact binary value rounded
/// half-up in magnitude (Rust's `{:.N}` rounds exact ties to even).
pub(crate) fn js_to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.abs() >= 1e21 {
        return js_num(x);
    }
    let neg = x < 0.0;
    let exact = format!("{:.1100}", x.abs());
    let (ip, fp) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let fp = fp.as_bytes();
    let mut num: Vec<u8> = ip.bytes().chain(fp.iter().take(digits).copied()).collect();
    if fp.get(digits).is_some_and(|c| *c >= b'5') {
        let mut i = num.len();
        loop {
            if i == 0 {
                num.insert(0, b'1');
                break;
            }
            i -= 1;
            if num[i] == b'9' {
                num[i] = b'0';
            } else {
                num[i] += 1;
                break;
            }
        }
    }
    let s = String::from_utf8_lossy(&num).into_owned();
    let body = if digits == 0 {
        s
    } else {
        let (a, b) = s.split_at(s.len() - digits);
        format!("{a}.{b}")
    };
    if neg {
        format!("-{body}")
    } else {
        body
    }
}

/// `parseFloat(s)`: the longest decimal-literal prefix after leading white
/// space, NaN when there is none.
pub(crate) fn js_parse_float(s: &str) -> f64 {
    let t = s.trim_start_matches(is_js_whitespace);
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    if rest.starts_with("Infinity") {
        return if neg {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let b = rest.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        let frac = j - i - 1;
        if digits + frac > 0 {
            digits += frac;
            i = j;
        }
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let exp_start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > exp_start {
            i = j;
        }
    }
    let v = rest[..i].parse::<f64>().unwrap_or(f64::NAN);
    if neg {
        -v
    } else {
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_arithmetic_matches_shared_utils() {
        // dates.test.ts "calendar-date arithmetic"
        assert_eq!(add_months_iso("2026-01-31", 1.0, Some(31.0)), "2026-02-28");
        assert_eq!(add_months_iso("2026-02-28", 1.0, Some(31.0)), "2026-03-31");
        assert_eq!(add_months_iso("2024-02-29", 12.0, Some(29.0)), "2025-02-28");
        assert_eq!(add_months_iso("2026-11-15", 3.0, None), "2027-02-15");
        assert_eq!(add_days_iso("2026-12-28", 7.0), "2027-01-04");
    }

    #[test]
    fn js_date_quirks() {
        assert_eq!(previous_month("2026-01"), "2025-12");
        assert_eq!(previous_month("2026-07"), "2026-06");
        // Years 0-99 are 1900-1999 to `new Date(y, m, d)`.
        assert_eq!(previous_month("0001-01"), "1900-12");
        assert_eq!(month_end("2026-02"), "2026-02-28");
        assert_eq!(month_end("2024-02"), "2024-02-29");
        assert_eq!(month_end("0000-02"), "0000-02-28");
        assert_eq!(month_end("2026-12"), "2026-12-31");
        assert_eq!(
            shift_iso_date("2026-03-01", -3.0).as_deref(),
            Some("2026-02-26")
        );
        assert_eq!(
            shift_iso_date("0050-01-01", -3.0).as_deref(),
            Some("1949-12-29")
        );
        assert_eq!(
            shift_iso_date("9999-12-31", 3.0).as_deref(),
            Some("+010000-01")
        );
        assert_eq!(day_of_month("2026-05-15"), 15.0);
        assert!(day_of_month("bad").is_nan());
        assert_eq!(add_months_iso("bad", 1.0, None), "NaN-NaN-NaN");
    }

    #[test]
    fn numbers_format_like_js() {
        assert_eq!(js_num(5.0), "5");
        assert_eq!(js_num(-0.0), "0");
        assert_eq!(js_num(1.5), "1.5");
        assert_eq!(js_num(1e21), "1e+21");
        assert_eq!(js_num(1e-7), "1e-7");
        assert_eq!(js_num(0.000001), "0.000001");
        assert_eq!(js_num(123456.789), "123456.789");
        assert_eq!(pad2(3.0), "03");
        assert_eq!(pad2(f64::NAN), "NaN");
    }

    #[test]
    fn rounding_like_js() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert!(js_round(-0.4).is_sign_negative());
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(1234.5678 * 100.0) / 100.0, 1234.57);
        assert_eq!(js_to_fixed(0.125, 2), "0.13");
        assert_eq!(js_to_fixed(-0.125, 2), "-0.13");
        assert_eq!(js_to_fixed(1.005, 2), "1.00");
        assert_eq!(js_to_fixed(-0.0, 2), "0.00");
        assert_eq!(js_to_fixed(-0.001, 2), "-0.00");
        assert_eq!(js_to_fixed(9.999, 2), "10.00");
        assert_eq!(js_to_fixed(50000.0, 2), "50000.00");
    }

    #[test]
    fn parse_float_like_js() {
        assert_eq!(js_parse_float("12.50"), 12.5);
        assert_eq!(js_parse_float("  -3"), -3.0);
        assert_eq!(js_parse_float("1,234.50"), 1.0);
        assert!(js_parse_float("$12").is_nan());
        assert_eq!(js_parse_float("12abc"), 12.0);
        assert_eq!(js_parse_float(".5"), 0.5);
        assert_eq!(js_parse_float("1."), 1.0);
        assert_eq!(js_parse_float("1e"), 1.0);
        assert_eq!(js_parse_float("1e3x"), 1000.0);
        assert!(js_parse_float("-0").is_sign_negative());
        assert_eq!(js_parse_float("Infinityx"), f64::INFINITY);
        assert!(js_parse_float("").is_nan());
        assert!(js_parse_float(".").is_nan());
        assert!(js_parse_float("e5").is_nan());
    }
}
