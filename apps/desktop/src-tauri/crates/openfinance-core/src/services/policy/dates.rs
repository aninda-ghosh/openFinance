//! JavaScript date and number semantics used by the policy services.
//! Owner: Wave 1 (policies).
//!
//! Ports `packages/shared/src/utils/date.ts` (`addMonthsIso`, `dayOfMonth`,
//! `daysBetweenIso`, `daysInMonth`, `localIsoDate`) with the exact JS number
//! behaviour those helpers have on odd input (`Number()` on each part, NaN
//! propagation, `Date.UTC`'s 0–99 → 1900s year rule, `String(n)`), plus the
//! pieces of `Date` the services touch: `new Date(string)` / `Date.parse`,
//! `setFullYear` in local time, and local calendar fields.
//!
//! Times are `f64` milliseconds since the epoch, NaN for an invalid date,
//! exactly like a JS time value. Calendar strings are compared with
//! [`js_str_cmp`] (UTF-16 code-unit order, as JS `<`/`>` do).

use std::cmp::Ordering;

use chrono::{DateTime, Local, LocalResult, NaiveDateTime, Offset, TimeZone};

use crate::json::string_to_number;

pub const MS_PER_DAY: f64 = 86_400_000.0;

// ─── Numbers ─────────────────────────────────────────────────────────────────

/// `String(n)` / template-literal interpolation of a JS number.
pub fn js_number_to_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if f == 0.0 {
        return "0".into(); // also -0
    }
    if f < 0.0 {
        return format!("-{}", js_number_to_string(-f));
    }
    // Shortest round-trip digits, closest to the value when several are as
    // short (ryu via serde_json, as ECMA-262 Number::toString requires).
    let repr = serde_json::Number::from_f64(f).map_or_else(String::new, |n| n.to_string());
    let (mantissa, exp) = repr.split_once(['e', 'E']).unwrap_or((repr.as_str(), "0"));
    let exp: i64 = exp.parse().unwrap_or(0);
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i64;
    let all: String = mantissa.chars().filter(|c| *c != '.').collect();
    let lead = all.len() - all.trim_start_matches('0').len();
    let digits = all
        .trim_start_matches('0')
        .trim_end_matches('0')
        .to_string();
    // value = 0.<digits> × 10^n
    let n = point - lead as i64 + exp;
    let k = digits.len() as i64;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (a, b) = digits.split_at(n as usize);
        format!("{a}.{b}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n - 1 < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{sign}{}", (n - 1).abs())
        } else {
            format!("{first}.{rest}e{sign}{}", (n - 1).abs())
        }
    }
}

/// `String(n).padStart(2, "0")`.
pub fn pad2(n: f64) -> String {
    let s = js_number_to_string(n);
    if s.len() < 2 {
        format!("0{s}")
    } else {
        s
    }
}

/// `Math.min(a, b)` (NaN wins, -0 < +0).
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == b {
        return if a.is_sign_negative() { a } else { b };
    }
    a.min(b)
}

/// `Math.round(x)`: halves round towards +Infinity.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    let r = x.floor();
    if x - r >= 0.5 {
        r + 1.0
    } else {
        r
    }
}

/// `ToIntegerOrInfinity` for an already-finite number.
fn trunc(x: f64) -> f64 {
    let t = x.trunc();
    if t == 0.0 {
        0.0
    } else {
        t
    }
}

// ─── Strings ─────────────────────────────────────────────────────────────────

/// JS relational comparison of two strings (UTF-16 code units).
pub fn js_str_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `s.slice(start, end)` on UTF-16 code units. A split surrogate pair becomes
/// U+FFFD (Rust strings cannot hold a lone surrogate).
pub fn js_slice(s: &str, start: usize, end: usize) -> String {
    if s.is_ascii() {
        let end = end.min(s.len());
        return s.get(start.min(end)..end).unwrap_or("").to_string();
    }
    let units: Vec<u16> = s.encode_utf16().collect();
    let end = end.min(units.len());
    String::from_utf16_lossy(&units[start.min(end)..end])
}

// ─── Time values (ECMA-262 §21.4.1) ──────────────────────────────────────────

/// Days from 1970-01-01 to the first of `month` (1-based) in `year`.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month 1-based, day) of a day number since the epoch.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `MakeDay(year, month, date)`: a day number, NaN when not representable.
pub fn make_day(year: f64, month: f64, date: f64) -> f64 {
    if !year.is_finite() || !month.is_finite() || !date.is_finite() {
        return f64::NAN;
    }
    let (y, m, dt) = (trunc(year), trunc(month), trunc(date));
    let ym = y + (m / 12.0).floor();
    // V8 rejects years outside ±1,000,000 (TimeClip would anyway).
    if !ym.is_finite() || ym.abs() > 1_000_000.0 {
        return f64::NAN;
    }
    let mn = m.rem_euclid(12.0);
    days_from_civil(ym as i64, mn as i64 + 1, 1) as f64 + dt - 1.0
}

/// `MakeDate(day, time)`.
pub fn make_date(day: f64, time: f64) -> f64 {
    if !day.is_finite() || !time.is_finite() {
        return f64::NAN;
    }
    day * MS_PER_DAY + time
}

/// `TimeClip(t)`.
pub fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > 8.64e15 {
        return f64::NAN;
    }
    trunc(t)
}

/// `Date.UTC(year, month, date)` (all three arguments present).
pub fn date_utc(year: f64, month: f64, date: f64) -> f64 {
    let yr = if year.is_nan() {
        year
    } else {
        let yi = if year.is_finite() { trunc(year) } else { year };
        if (0.0..=99.0).contains(&yi) {
            1900.0 + yi
        } else {
            year
        }
    };
    time_clip(make_date(make_day(yr, month, date), 0.0))
}

/// UTC calendar fields of a valid time value: (year, month 0-based, day, ms in day).
fn utc_fields(t: f64) -> (f64, f64, f64, f64) {
    let day = (t / MS_PER_DAY).floor();
    let (y, m, d) = civil_from_days(day as i64);
    (y as f64, (m - 1) as f64, d as f64, t - day * MS_PER_DAY)
}

/// `new Date(t).getUTCDate()`.
pub fn utc_date(t: f64) -> f64 {
    if t.is_nan() {
        return f64::NAN;
    }
    utc_fields(t).2
}

// ─── Local time ──────────────────────────────────────────────────────────────

/// chrono's range is about ±262,000 years; JS dates reach ±275,760. Beyond
/// it the zone offset of the nearest representable instant is used.
const CHRONO_MIN_MS: f64 = -8_200_000_000_000_000.0;
const CHRONO_MAX_MS: f64 = 8_200_000_000_000_000.0;

fn naive_from_ms(ms: f64) -> Option<NaiveDateTime> {
    let ms = ms.clamp(CHRONO_MIN_MS, CHRONO_MAX_MS) as i64;
    DateTime::from_timestamp_millis(ms).map(|d| d.naive_utc())
}

/// The local zone's offset (ms) at UTC instant `t`.
fn local_offset_at_utc(t: f64) -> f64 {
    naive_from_ms(t).map_or(0.0, |n| {
        f64::from(Local.offset_from_utc_datetime(&n).fix().local_minus_utc()) * 1000.0
    })
}

/// `LocalTime(t)`.
pub fn local_time(t: f64) -> f64 {
    if t.is_nan() {
        return t;
    }
    t + local_offset_at_utc(t)
}

/// `UTC(t)` for a local time value: an ambiguous wall time takes the earlier
/// instant and a skipped one the offset before the transition (V8/ICU "former").
pub fn utc_from_local(t: f64) -> f64 {
    if !t.is_finite() {
        return f64::NAN;
    }
    let Some(naive) = naive_from_ms(t) else {
        return f64::NAN;
    };
    let offset = match Local.offset_from_local_datetime(&naive) {
        LocalResult::Single(o) | LocalResult::Ambiguous(o, _) => {
            f64::from(o.fix().local_minus_utc()) * 1000.0
        }
        LocalResult::None => local_offset_at_utc(t - MS_PER_DAY),
    };
    t - offset
}

/// The current time value (`Date.now()`).
pub fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// Local (year, month 0-based, day) of a time value, NaN for an invalid date.
pub fn local_fields(t: f64) -> (f64, f64, f64) {
    if t.is_nan() {
        return (f64::NAN, f64::NAN, f64::NAN);
    }
    let (y, m, d, _) = utc_fields(local_time(t));
    (y, m, d)
}

/// `localIsoDate(d)`: `${getFullYear()}-${pad2(getMonth() + 1)}-${pad2(getDate())}`.
pub fn local_iso_date(t: f64) -> String {
    let (y, m, d) = local_fields(t);
    format!("{}-{}-{}", js_number_to_string(y), pad2(m + 1.0), pad2(d))
}

/// `localIsoDate()` for now.
pub fn local_iso_today() -> String {
    local_iso_date(now_ms())
}

/// `d.setFullYear(year)` (local time) on time value `t`; returns the new value.
pub fn set_full_year_local(t: f64, year: f64) -> f64 {
    let lt = if t.is_nan() { 0.0 } else { local_time(t) };
    let (_, m, d, within) = utc_fields(lt);
    let new_date = make_date(make_day(year, m, d), within);
    time_clip(utc_from_local(new_date))
}

/// `new Date(t).getFullYear()`.
pub fn local_full_year(t: f64) -> f64 {
    local_fields(t).0
}

// ─── Calendar-date helpers (packages/shared/src/utils/date.ts) ───────────────

/// `iso.slice(0, 10).split("-").map(Number)` destructured as `[y, m, d]`;
/// `None` is `undefined`.
pub fn split_iso(iso: &str) -> [Option<f64>; 3] {
    let head = js_slice(iso, 0, 10);
    let mut parts = head.split('-').map(string_to_number);
    [parts.next(), parts.next(), parts.next()]
}

/// JS arithmetic on a possibly-undefined number.
fn num(v: Option<f64>) -> f64 {
    v.unwrap_or(f64::NAN)
}

/// `daysInMonth(year, month)`: `new Date(Date.UTC(year, month, 0)).getUTCDate()`.
pub fn days_in_month(year: f64, month: f64) -> f64 {
    utc_date(date_utc(year, month, 0.0))
}

/// `addMonthsIso(iso, months, anchorDay)`.
pub fn add_months_iso(iso: &str, months: f64, anchor_day: Option<f64>) -> String {
    let [y, m, d] = split_iso(iso);
    let total = num(y) * 12.0 + (num(m) - 1.0) + months;
    let ny = (total / 12.0).floor();
    let nm = (total % 12.0) + 1.0;
    let day = js_min(num(anchor_day.or(d)), days_in_month(ny, nm));
    format!("{}-{}-{}", js_number_to_string(ny), pad2(nm), pad2(day))
}

/// `dayOfMonth(iso)`.
pub fn day_of_month(iso: &str) -> Option<f64> {
    split_iso(iso)[2]
}

/// `daysBetweenIso(fromIso, toIso)`.
pub fn days_between_iso(from_iso: &str, to_iso: &str) -> f64 {
    let [y1, m1, d1] = split_iso(from_iso);
    let [y2, m2, d2] = split_iso(to_iso);
    js_round(
        (date_utc(num(y2), num(m2) - 1.0, num(d2)) - date_utc(num(y1), num(m1) - 1.0, num(d1)))
            / MS_PER_DAY,
    )
}

// ─── Date string parsing (V8's DateParser) ───────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// Digits: value (leading zeros skipped, at most 9 significant digits) and length.
    Num(i64, usize),
    Sym(char),
    Space,
    Word(String),
    End,
}

fn tokenize(s: &str) -> Vec<Tok> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() {
            let start = i;
            while i < chars.len() && chars[i] == '0' {
                i += 1;
            }
            let mut n: i64 = 0;
            let mut sig = 0;
            while i < chars.len() && chars[i].is_ascii_digit() {
                if sig < 9 {
                    n = n * 10 + i64::from(chars[i] as u8 - b'0');
                }
                sig += 1;
                i += 1;
            }
            out.push(Tok::Num(n, i - start));
        } else if c.is_alphabetic() {
            let start = i;
            while i < chars.len() && chars[i].is_alphabetic() {
                i += 1;
            }
            out.push(Tok::Word(
                chars[start..i].iter().collect::<String>().to_lowercase(),
            ));
        } else if c.is_whitespace() {
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            out.push(Tok::Space);
        } else {
            out.push(Tok::Sym(c));
            i += 1;
        }
    }
    out.push(Tok::End);
    out
}

struct Scanner {
    toks: Vec<Tok>,
    pos: usize,
}

impl Scanner {
    fn peek(&self) -> &Tok {
        self.toks.get(self.pos).unwrap_or(&Tok::End)
    }
    fn next(&mut self) -> Tok {
        let t = self.peek().clone();
        if self.pos < self.toks.len() {
            self.pos += 1;
        }
        t
    }
    fn skip_sym(&mut self, c: char) -> bool {
        if *self.peek() == Tok::Sym(c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn peek_fixed(&self, len: usize) -> Option<i64> {
        match self.peek() {
            Tok::Num(n, l) if *l == len => Some(*n),
            _ => None,
        }
    }
}

#[derive(Default)]
struct Parsed {
    day: Vec<i64>,
    time: Vec<i64>,
    tz_ms: Option<f64>,
    iso: bool,
}

enum Es5 {
    Invalid,
    Done,
    /// Not (fully) ES5: continue with the legacy parser from this token.
    Continue(Tok),
}

fn parse_es5(sc: &mut Scanner, p: &mut Parsed) -> Es5 {
    if let Tok::Sym(sign @ ('+' | '-')) = sc.peek().clone() {
        sc.next();
        let Some(y) = sc.peek_fixed(6) else {
            return Es5::Continue(sc.next());
        };
        sc.next();
        if sign == '-' && y == 0 {
            // "-000000": the year is dropped and parsing goes on (legacy).
            return Es5::Continue(sc.next());
        }
        p.day.push(if sign == '-' { -y } else { y });
    } else if let Some(y) = sc.peek_fixed(4) {
        sc.next();
        p.day.push(y);
    } else {
        return Es5::Continue(sc.next());
    }
    if sc.skip_sym('-') {
        match sc.peek_fixed(2) {
            Some(m) if (1..=12).contains(&m) => {
                sc.next();
                p.day.push(m);
            }
            _ => return Es5::Continue(sc.next()),
        }
        if sc.skip_sym('-') {
            match sc.peek_fixed(2) {
                Some(d) if (1..=31).contains(&d) => {
                    sc.next();
                    p.day.push(d);
                }
                _ => return Es5::Continue(sc.next()),
            }
        }
    }
    if !matches!(sc.peek(), Tok::Word(w) if w == "t") {
        if *sc.peek() != Tok::End {
            return Es5::Continue(sc.next());
        }
    } else {
        sc.next();
        let Some(h) = sc.peek_fixed(2).filter(|h| (0..=24).contains(h)) else {
            return Es5::Invalid;
        };
        let hour_24 = h == 24;
        sc.next();
        if !sc.skip_sym(':') {
            return Es5::Invalid;
        }
        let Some(mi) = sc
            .peek_fixed(2)
            .filter(|m| (0..=59).contains(m) && !(hour_24 && *m > 0))
        else {
            return Es5::Invalid;
        };
        sc.next();
        p.time.extend([h, mi]);
        if sc.skip_sym(':') {
            let Some(s) = sc
                .peek_fixed(2)
                .filter(|s| (0..=59).contains(s) && !(hour_24 && *s > 0))
            else {
                return Es5::Invalid;
            };
            sc.next();
            p.time.push(s);
            if sc.skip_sym('.') {
                let Tok::Num(_, _) = sc.peek() else {
                    return Es5::Invalid;
                };
                // Re-read the raw digits: milliseconds use the first three.
                let ms = match sc.next() {
                    Tok::Num(n, len) => millis(n, len),
                    _ => 0,
                };
                if hour_24 && ms > 0 {
                    return Es5::Invalid;
                }
                p.time.push(ms);
            }
        }
        if matches!(sc.peek(), Tok::Word(w) if w == "z") {
            sc.next();
            p.tz_ms = Some(0.0);
        } else if let Tok::Sym(sign @ ('+' | '-')) = sc.peek().clone() {
            sc.next();
            let Some(oh) = sc.peek_fixed(2).filter(|h| (0..=23).contains(h)) else {
                return Es5::Invalid;
            };
            sc.next();
            if !sc.skip_sym(':') {
                return Es5::Invalid;
            }
            let Some(om) = sc.peek_fixed(2).filter(|m| (0..=59).contains(m)) else {
                return Es5::Invalid;
            };
            sc.next();
            let off = (oh * 60 + om) as f64 * 60_000.0;
            p.tz_ms = Some(if sign == '-' { -off } else { off });
        }
        if *sc.peek() != Tok::End {
            return Es5::Invalid;
        }
    }
    if p.tz_ms.is_none() && p.time.is_empty() {
        p.tz_ms = Some(0.0);
    }
    p.iso = true;
    Es5::Done
}

/// V8 `ReadMilliseconds`: the first three digits of the fraction.
fn millis(n: i64, len: usize) -> i64 {
    // `n` dropped leading zeros; rebuild the digit string to its full length.
    let digits = format!("{:0>width$}", n, width = len);
    let first3: String = digits.chars().take(3).collect();
    let v: i64 = first3.parse().unwrap_or(0);
    match first3.len() {
        1 => v * 100,
        2 => v * 10,
        _ => v,
    }
}

/// `Date.parse(s)` / `new Date(s).getTime()`.
///
/// The ES5 ISO format is handled exactly as V8 does. Of V8's legacy fallback
/// only the forms made of digits, `-` and whitespace are implemented (what
/// `addMonthsIso` can produce from any integer input); anything else that
/// is not ES5 returns NaN (see QUIRKS.md, Wave 1 policies).
pub fn parse_date(s: &str) -> f64 {
    let mut sc = Scanner {
        toks: tokenize(s),
        pos: 0,
    };
    let mut p = Parsed::default();
    let first = match parse_es5(&mut sc, &mut p) {
        Es5::Invalid => return f64::NAN,
        Es5::Done => None,
        Es5::Continue(tok) => Some(tok),
    };
    if let Some(mut tok) = first {
        let mut has_read_number = !p.day.is_empty();
        loop {
            match tok {
                Tok::End => break,
                Tok::Num(n, _) => {
                    has_read_number = true;
                    if matches!(sc.peek(), Tok::Sym(':' | '.')) {
                        return f64::NAN; // legacy time forms: not implemented
                    }
                    if p.day.len() == 3 {
                        return f64::NAN;
                    }
                    p.day.push(n);
                    sc.skip_sym('-');
                }
                Tok::Sym('+' | '-') if has_read_number => return f64::NAN,
                Tok::Sym('+' | '-') | Tok::Space => {}
                // Words, other symbols: not implemented (V8 rejects most of
                // them after a number has been read).
                _ => return f64::NAN,
            }
            tok = sc.next();
        }
    }
    compose(&p)
}

fn compose(p: &Parsed) -> f64 {
    if p.day.is_empty() {
        return f64::NAN;
    }
    let mut comp = p.day.clone();
    while comp.len() < 3 {
        comp.push(1);
    }
    let is_day = |x: i64| (1..=31).contains(&x);
    let (mut year, month, day) = if p.iso || !is_day(comp[0]) {
        (comp[0], comp[1], comp[2])
    } else {
        (comp[2], comp[0], comp[1])
    };
    if !p.iso {
        if (0..=49).contains(&year) {
            year += 2000;
        } else if (50..=99).contains(&year) {
            year += 1900;
        }
    }
    if !(1..=12).contains(&month) || !is_day(day) {
        return f64::NAN;
    }
    let t = |i: usize| p.time.get(i).copied().unwrap_or(0) as f64;
    let time = ((t(0) * 60.0 + t(1)) * 60.0 + t(2)) * 1000.0 + t(3);
    let date = make_date(make_day(year as f64, (month - 1) as f64, day as f64), time);
    let utc = match p.tz_ms {
        Some(off) => date - off,
        None => utc_from_local(date),
    };
    time_clip(utc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_to_string_matches_js() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (5.0, "5"),
            (-5.0, "-5"),
            (2026.0, "2026"),
            (1.5, "1.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123456789.125, "123456789.125"),
            (123456789012345680000.0, "123456789012345680000"),
            (5e-324, "5e-324"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
        ];
        for (n, s) in cases {
            assert_eq!(js_number_to_string(*n), *s, "{n}");
        }
        assert_eq!(pad2(5.0), "05");
        assert_eq!(pad2(f64::NAN), "NaN");
        assert_eq!(pad2(-3.0), "-3");
        assert_eq!(pad2(-0.0), "00");
    }

    // dates.test.ts: "calendar-date arithmetic"
    #[test]
    fn add_months_clamps_to_month_end_and_returns_to_anchor() {
        assert_eq!(add_months_iso("2026-01-31", 1.0, Some(31.0)), "2026-02-28");
        assert_eq!(add_months_iso("2026-02-28", 1.0, Some(31.0)), "2026-03-31");
        assert_eq!(add_months_iso("2024-02-29", 12.0, Some(29.0)), "2025-02-28");
        assert_eq!(add_months_iso("2026-11-15", 3.0, None), "2027-02-15");
    }

    #[test]
    fn add_months_on_odd_input_follows_js() {
        assert_eq!(add_months_iso("abc", 1.0, None), "NaN-NaN-NaN");
        assert_eq!(add_months_iso("2024-01", 1.0, None), "2024-02-NaN");
        assert_eq!(add_months_iso("2024-01-15", -1.0, None), "2023-12-15");
        // Date.UTC maps years 0-99 to 1900-1999: year 0 is not a leap year.
        assert_eq!(add_months_iso("0000-01-29", 1.0, None), "0-02-28");
        assert_eq!(days_in_month(2024.0, 2.0), 29.0);
        assert_eq!(days_in_month(2100.0, 2.0), 28.0);
        assert!(days_in_month(f64::NAN, 2.0).is_nan());
    }

    #[test]
    fn days_between() {
        assert_eq!(days_between_iso("2026-01-01", "2026-03-01"), 59.0);
        assert_eq!(days_between_iso("2026-03-01", "2026-01-01"), -59.0);
        assert!(days_between_iso("2026-01-01", "x").is_nan());
    }

    #[test]
    fn local_iso_date_uses_local_calendar_day() {
        // dates.test.ts: 11pm on Sep 30 local is still Sep 30.
        let local = make_date(make_day(2026.0, 8.0, 30.0), 23.0 * 3_600_000.0);
        assert_eq!(local_iso_date(utc_from_local(local)), "2026-09-30");
        assert_eq!(local_iso_date(f64::NAN), "NaN-NaN-NaN");
    }

    #[test]
    fn parse_iso_forms() {
        assert_eq!(parse_date("2026-01-05"), 1_767_571_200_000.0);
        assert_eq!(parse_date("2026-01"), 1_767_225_600_000.0);
        assert_eq!(parse_date("2026"), 1_767_225_600_000.0);
        assert_eq!(parse_date("+002026-01-05"), 1_767_571_200_000.0);
        assert_eq!(parse_date("2026-02-30"), 1_772_409_600_000.0);
        assert_eq!(parse_date("0999-01-01"), -30_641_760_000_000.0);
        assert_eq!(parse_date("2026-01-05T00:00:00Z"), 1_767_571_200_000.0);
        assert_eq!(parse_date("2026-01-05T24:00:00Z"), 1_767_657_600_000.0);
        assert_eq!(parse_date("2026-01-05T00:00:00.5Z"), 1_767_571_200_500.0);
        for bad in [
            "NaN-NaN-NaN",
            "2024-02-NaN",
            "2026-13-01",
            "2026-00-10",
            "2026-01-32",
            "2026-01-05-",
            "2026-1-1-1",
            "2026--01-01",
            "1234567-01-01",
            "2026-1-5T00:00:00Z",
            "T00:00:00Z",
            "",
        ] {
            assert!(parse_date(bad).is_nan(), "{bad}");
        }
    }

    #[test]
    fn parse_legacy_numeric_forms_are_local() {
        let local = |y: f64, m: f64, d: f64| utc_from_local(make_date(make_day(y, m, d), 0.0));
        assert_eq!(parse_date("2026-1-5"), local(2026.0, 0.0, 5.0));
        assert_eq!(parse_date("2026-01-5"), local(2026.0, 0.0, 5.0));
        assert_eq!(parse_date("2026-01-05 "), local(2026.0, 0.0, 5.0));
        assert_eq!(parse_date("12345-01-01"), local(12345.0, 0.0, 1.0));
        assert_eq!(parse_date("999-01-01"), local(999.0, 0.0, 1.0));
        assert_eq!(parse_date("99-01-01"), local(1999.0, 0.0, 1.0));
        assert_eq!(parse_date("0049-1-1"), local(2049.0, 0.0, 1.0));
        assert_eq!(parse_date("5-01-2026"), local(2026.0, 4.0, 1.0));
        assert_eq!(parse_date("1-1-1"), local(2001.0, 0.0, 1.0));
        assert_eq!(parse_date("0-1-1"), local(2000.0, 0.0, 1.0));
        assert_eq!(parse_date("-5-03-01"), local(2001.0, 4.0, 3.0));
        assert_eq!(parse_date("-2026-01-01"), local(2026.0, 0.0, 1.0));
        assert_eq!(parse_date("2026-2-31"), local(2026.0, 2.0, 3.0));
        assert_eq!(parse_date("2026-1-"), local(2026.0, 0.0, 1.0));
        assert_eq!(parse_date("5"), local(2001.0, 4.0, 1.0));
    }

    #[test]
    fn set_full_year_overflows_like_js() {
        let feb29 = utc_from_local(make_date(make_day(2024.0, 1.0, 29.0), 3_600_000.0));
        let next = set_full_year_local(feb29, 2025.0);
        assert_eq!(local_iso_date(next), "2025-03-01");
        assert!(set_full_year_local(feb29, f64::NAN).is_nan());
        assert_eq!(
            local_iso_date(set_full_year_local(feb29, 2030.7)),
            "2030-03-01"
        );
    }

    #[test]
    fn rounding_and_min() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert!(js_min(f64::NAN, 1.0).is_nan());
        assert!(js_min(-0.0, 0.0).is_sign_negative());
    }
}
