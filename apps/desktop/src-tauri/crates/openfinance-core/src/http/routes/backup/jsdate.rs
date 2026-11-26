//! The slice of JavaScript `Date` that the backup import's policy pipeline
//! uses (`new Date(x)`, `getFullYear`/`setFullYear`, `getMonth`/`setMonth`,
//! comparisons), on time values in milliseconds (`f64`, NaN = Invalid Date).
//! Local time follows the process time zone, as V8 does.
//!
//! String parsing covers the ES ISO format (as V8 accepts it) and the common
//! numeric forms of V8's legacy parser (`2020/1/5`, `2020-1-5 10:00`,
//! `1/5/2020`, surrounding whitespace). Other legacy forms (month names,
//! two-digit years, …) parse to NaN here; a known, accepted difference from Node.

use chrono::{Local, LocalResult, NaiveDateTime, Offset, TimeZone};

const MS_PER_DAY: f64 = 86_400_000.0;

/// `TimeClip(t)`.
pub fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > 8.64e15 {
        return f64::NAN;
    }
    t.trunc() + 0.0
}

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1-12).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month 0-11, day 1-31) of a day number.
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
    (if m <= 2 { y + 1 } else { y }, m - 1, d)
}

/// `MakeDay(year, month, date)` (month 0-based, may overflow).
fn make_day(year: f64, month: f64, date: f64) -> f64 {
    if !year.is_finite() || !month.is_finite() || !date.is_finite() {
        return f64::NAN;
    }
    let (y, m, dt) = (year.trunc(), month.trunc(), date.trunc());
    let ym = y + (m / 12.0).floor();
    if ym.abs() > 400_000.0 {
        return f64::NAN;
    }
    let mn = m.rem_euclid(12.0);
    days_from_civil(ym as i64, mn as i64 + 1, 1) as f64 + dt - 1.0
}

/// `MakeTime(h, min, s, ms)`.
fn make_time(h: f64, min: f64, s: f64, ms: f64) -> f64 {
    h.trunc() * 3_600_000.0 + min.trunc() * 60_000.0 + s.trunc() * 1000.0 + ms.trunc()
}

fn make_date(day: f64, time: f64) -> f64 {
    if !day.is_finite() || !time.is_finite() {
        return f64::NAN;
    }
    day * MS_PER_DAY + time
}

fn naive(t: f64) -> Option<NaiveDateTime> {
    chrono::DateTime::from_timestamp_millis(t as i64).map(|d| d.naive_utc())
}

/// Offset of local time from UTC at UTC instant `t`, in ms.
fn offset_at_utc(t: f64) -> f64 {
    match naive(t) {
        Some(n) => f64::from(Local.offset_from_utc_datetime(&n).fix().local_minus_utc()) * 1000.0,
        None => 0.0,
    }
}

/// `LocalTime(t)`.
fn local_time(t: f64) -> f64 {
    t + offset_at_utc(t)
}

/// `UTC(t)` for a local time value: ambiguous times take the earlier
/// instant, skipped times use the offset from before the transition.
fn utc(t: f64) -> f64 {
    if !t.is_finite() {
        return f64::NAN;
    }
    let Some(n) = naive(t) else {
        return t;
    };
    let offset = match Local.from_local_datetime(&n) {
        LocalResult::Single(dt) => dt.offset().fix().local_minus_utc(),
        LocalResult::Ambiguous(a, _) => a.offset().fix().local_minus_utc(),
        LocalResult::None => {
            let before = n - chrono::Duration::days(1);
            match Local.from_local_datetime(&before) {
                LocalResult::Single(dt) | LocalResult::Ambiguous(dt, _) => {
                    dt.offset().fix().local_minus_utc()
                }
                LocalResult::None => 0,
            }
        }
    };
    t - f64::from(offset) * 1000.0
}

fn day_of(t: f64) -> f64 {
    (t / MS_PER_DAY).floor()
}

fn time_within_day(t: f64) -> f64 {
    t.rem_euclid(MS_PER_DAY)
}

fn ymd(t: f64) -> (f64, f64, f64) {
    let (y, m, d) = civil_from_days(day_of(t) as i64);
    (y as f64, m as f64, d as f64)
}

/// `date.getFullYear()`.
pub fn get_full_year(t: f64) -> f64 {
    if t.is_nan() {
        return f64::NAN;
    }
    ymd(local_time(t)).0
}

/// `date.getMonth()`.
pub fn get_month(t: f64) -> f64 {
    if t.is_nan() {
        return f64::NAN;
    }
    ymd(local_time(t)).1
}

/// `date.setFullYear(y)`: returns the new time value.
pub fn set_full_year(t: f64, year: f64) -> f64 {
    let lt = if t.is_nan() { 0.0 } else { local_time(t) };
    let (_, m, d) = ymd(lt);
    let new_date = make_date(make_day(year, m, d), time_within_day(lt));
    time_clip(utc(new_date))
}

/// `date.setMonth(m)`: returns the new time value.
pub fn set_month(t: f64, month: f64) -> f64 {
    if t.is_nan() {
        return f64::NAN;
    }
    let lt = local_time(t);
    let (y, _, d) = ymd(lt);
    let new_date = make_date(make_day(y, month, d), time_within_day(lt));
    time_clip(utc(new_date))
}

/// `Date.now()`.
pub fn now() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// `Date.parse(s)` (see the module docs for the supported forms).
pub fn parse(s: &str) -> f64 {
    match parse_iso(s) {
        Some(t) => t,
        None => parse_legacy(s),
    }
}

struct Cursor<'a> {
    s: &'a [u8],
    i: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn digits(&mut self, n: usize) -> Option<f64> {
        let part = self.s.get(self.i..self.i + n)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.i += n;
        std::str::from_utf8(part).ok()?.parse().ok()
    }
    fn digit_run(&mut self, min: usize, max: usize) -> Option<(f64, usize)> {
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i].is_ascii_digit() && self.i - start < max {
            self.i += 1;
        }
        let len = self.i - start;
        if len < min {
            self.i = start;
            return None;
        }
        let v = std::str::from_utf8(&self.s[start..self.i])
            .ok()?
            .parse()
            .ok()?;
        Some((v, len))
    }
    fn done(&self) -> bool {
        self.i == self.s.len()
    }
}

/// `None` when the string is not in ISO shape (the legacy parser then gets
/// it); `Some(NaN)` for ISO shape with out-of-range fields.
fn parse_iso(s: &str) -> Option<f64> {
    let mut c = Cursor {
        s: s.as_bytes(),
        i: 0,
    };
    let year = match c.peek() {
        Some(sign @ (b'+' | b'-')) => {
            c.i += 1;
            let y = c.digits(6)?;
            if sign == b'-' {
                if y == 0.0 {
                    return Some(f64::NAN);
                }
                -y
            } else {
                y
            }
        }
        _ => c.digits(4)?,
    };
    let mut month = 1.0;
    let mut day = 1.0;
    if c.eat(b'-') {
        month = c.digits(2)?;
        if c.eat(b'-') {
            day = c.digits(2)?;
        }
    }
    let (mut h, mut mi, mut sec, mut ms) = (0.0, 0.0, 0.0, 0.0);
    let mut has_time = false;
    let mut offset_min: Option<f64> = None;
    if c.eat(b'T') || c.eat(b't') {
        has_time = true;
        h = c.digits(2)?;
        if !c.eat(b':') {
            return None;
        }
        mi = c.digits(2)?;
        if c.eat(b':') {
            sec = c.digits(2)?;
            if c.eat(b'.') {
                let start = c.i;
                let (_, len) = c.digit_run(1, usize::MAX)?;
                let frac = &s[start..start + len.min(3)];
                let scale = 10f64.powi(3 - frac.len() as i32);
                ms = frac.parse::<f64>().ok()? * scale;
            }
        }
    }
    if c.eat(b'Z') || c.eat(b'z') {
        offset_min = Some(0.0);
    } else if has_time {
        if let Some(sign @ (b'+' | b'-')) = c.peek() {
            c.i += 1;
            let oh = c.digits(2)?;
            c.eat(b':');
            let om = c.digits(2)?;
            let total = oh * 60.0 + om;
            offset_min = Some(if sign == b'-' { -total } else { total });
        }
    }
    if !c.done() {
        return None;
    }
    let valid = (1.0..=12.0).contains(&month)
        && (1.0..=31.0).contains(&day)
        && (h < 24.0 || (h == 24.0 && mi == 0.0 && sec == 0.0 && ms == 0.0))
        && mi < 60.0
        && sec < 60.0;
    if !valid {
        return Some(f64::NAN);
    }
    let t = make_date(make_day(year, month - 1.0, day), make_time(h, mi, sec, ms));
    let t = match offset_min {
        Some(o) => t - o * 60_000.0,
        None if has_time => utc(t),
        None => t,
    };
    Some(time_clip(t))
}

/// The numeric forms of V8's legacy parser, in local time.
fn parse_legacy(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_ascii_whitespace());
    let mut c = Cursor {
        s: t.as_bytes(),
        i: 0,
    };
    let parsed = (|| {
        c.eat(b'+');
        let (a, alen) = c.digit_run(1, 6)?;
        let sep = c.peek().filter(|b| *b == b'-' || *b == b'/')?;
        c.i += 1;
        let (b, _) = c.digit_run(1, 2)?;
        if !c.eat(sep) {
            return None;
        }
        let (d3, d3len) = c.digit_run(1, 6)?;
        let (year, month, day) = if alen >= 3 {
            (a, b, d3)
        } else if sep == b'/' && d3len >= 3 {
            (d3, a, b)
        } else {
            return None;
        };
        let (mut h, mut mi, mut sec) = (0.0, 0.0, 0.0);
        if c.peek().is_some_and(|b| b.is_ascii_whitespace()) {
            while c.peek().is_some_and(|b| b.is_ascii_whitespace()) {
                c.i += 1;
            }
            h = c.digit_run(1, 2)?.0;
            if !c.eat(b':') {
                return None;
            }
            mi = c.digits(2)?;
            if c.eat(b':') {
                sec = c.digits(2)?;
            }
        }
        if !c.done() {
            return None;
        }
        let valid = (1.0..=12.0).contains(&month)
            && (1.0..=31.0).contains(&day)
            && h < 24.0
            && mi < 60.0
            && sec < 60.0;
        if !valid {
            return None;
        }
        let local = make_date(make_day(year, month - 1.0, day), make_time(h, mi, sec, 0.0));
        Some(time_clip(utc(local)))
    })();
    parsed.unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Offset-independent checks (the local ones depend on the machine's time zone).
    #[test]
    fn iso_utc_forms() {
        assert_eq!(parse("2021-02-31"), 1614729600000.0);
        assert_eq!(parse("2020-01-15T10:00:00.123456Z"), 1579082400123.0);
        assert_eq!(parse("+002020-01-15"), 1579046400000.0);
        assert_eq!(parse("2020"), 1577836800000.0);
        assert_eq!(parse("2020-01"), 1577836800000.0);
        assert_eq!(parse("2020-01-15T10:00+05:30"), 1579062600000.0);
        assert_eq!(parse("2020-01-15T10:00:00+0530"), 1579062600000.0);
        assert_eq!(parse("2020-02-30T00:00Z"), 1583020800000.0);
        assert_eq!(parse("2020-01-15Z"), 1579046400000.0);
        assert_eq!(parse("-000001-01-01"), -62198755200000.0);
        assert_eq!(parse("2020-01-15T10:00:00.000z"), 1579082400000.0);
        assert_eq!(parse("+010000-01-01"), 253402300800000.0);
        for bad in [
            "2020-13-01",
            "",
            "abc",
            "1577836800000",
            "2020-01-32",
            "2020-00-10",
            "2020-01-15T10:00:60",
            "2020-01-15T24:00:01",
            "2020-01-15T10",
            "20200115",
        ] {
            assert!(parse(bad).is_nan(), "{bad}");
        }
    }

    #[test]
    fn local_forms_match_utc_plus_offset() {
        let local_midnight = utc(make_date(make_day(2020.0, 0.0, 15.0), 0.0));
        for s in [
            "2020/01/15",
            "01/15/2020",
            "  2020-01-15",
            "2020-01-15 ",
            "2020-1-15",
            "002020-01-15",
        ] {
            assert_eq!(parse(s), local_midnight, "{s}");
        }
        assert_eq!(
            parse("2020-01-15T10:00"),
            utc(make_date(make_day(2020.0, 0.0, 15.0), 36_000_000.0))
        );
    }

    #[test]
    fn setters_overflow_like_js() {
        let t = utc(make_date(make_day(2024.0, 0.0, 31.0), 0.0));
        let feb = set_month(t, get_month(t) + 1.0);
        assert_eq!(ymd(local_time(feb)), (2024.0, 2.0, 2.0));
        let leap = parse("2024-02-29T12:00");
        let next = set_full_year(leap, get_full_year(leap) + 1.0);
        assert_eq!(ymd(local_time(next)), (2025.0, 2.0, 1.0));
        assert!(set_full_year(f64::NAN, f64::NAN).is_nan());
        assert!(set_month(f64::NAN, 1.0).is_nan());
        assert!(set_full_year(0.0, 300_000.0).is_nan());
    }

    #[test]
    fn civil_roundtrip() {
        for days in [-1_000_000, -719_468, -1, 0, 1, 18_276, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m + 1, d), days);
        }
    }
}
