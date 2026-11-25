//! `new Intl.NumberFormat(locale, { style: "currency", currency,
//! maximumFractionDigits: 0 }).format(n)` for the locales the AI code picks
//! (`CURRENCY_LOCALE[currency] ?? "en-US"`), as V8/ICU 78 renders them, and
//! `Number.prototype.toFixed`.
//!
//! Rounding is ICU's: half-expand on the shortest round-trip digits of the
//! double. Checked against V8 on ~7,000 inputs (`intl_v8.jsonl`).

use super::js::JsError;

/// A locale's number symbols.
#[derive(Clone, Copy, PartialEq)]
enum Locale {
    EnIn,
    EnUs,
    EnSg,
    EnGb,
    EnIe,
    JaJp,
    ZhTw,
}

impl Locale {
    fn from_tag(tag: &str) -> Self {
        match tag {
            "en-IN" => Locale::EnIn,
            "en-SG" => Locale::EnSg,
            "en-GB" => Locale::EnGb,
            "en-IE" => Locale::EnIe,
            "ja-JP" => Locale::JaJp,
            "zh-TW" => Locale::ZhTw,
            _ => Locale::EnUs,
        }
    }

    fn nan(self) -> &'static str {
        match self {
            Locale::ZhTw => "非數值",
            _ => "NaN",
        }
    }

    /// The currency symbol ICU uses in this locale (`code` is upper-case).
    fn symbol(self, code: &str) -> String {
        // Only the pairs the AI code can produce: a locale is chosen from its
        // own currency, and every other code is formatted in en-US.
        let s = match (self, code) {
            (Locale::EnIn, "INR") => "₹",
            (Locale::EnSg, "SGD") => "$",
            (Locale::EnGb, "GBP") => "£",
            (Locale::EnIe, "EUR") => "€",
            (Locale::JaJp, "JPY") => "￥",
            (Locale::ZhTw, "TWD") => "$",
            (Locale::EnUs, "EUR") => "€",
            (Locale::EnUs, "GBP") => "£",
            (Locale::EnUs, "INR") => "₹",
            (Locale::EnUs, "USD") => "$",
            (Locale::EnUs, "JPY") => "¥",
            (Locale::EnUs, "TWD") => "NT$",
            (Locale::EnUs, "CAD") => "CA$",
            (Locale::EnUs, "AUD") => "A$",
            (Locale::EnUs, "CNY") => "CN¥",
            (Locale::EnUs, "HKD") => "HK$",
            (Locale::EnUs, "NZD") => "NZ$",
            (Locale::EnUs, "MXN") => "MX$",
            (Locale::EnUs, "BRL") => "R$",
            (Locale::EnUs, "KRW") => "₩",
            (Locale::EnUs, "ILS") => "₪",
            (Locale::EnUs, "VND") => "₫",
            (Locale::EnUs, "PHP") => "₱",
            _ => return code.to_string(),
        };
        s.to_string()
    }
}

/// `IsWellFormedCurrencyCode`: three ASCII letters.
fn well_formed_currency(code: &str) -> bool {
    code.len() == 3 && code.bytes().all(|b| b.is_ascii_alphabetic())
}

/// Shortest round-trip decimal digits of a finite, non-negative double:
/// `(digits, exponent)` with value `0.d1d2… × 10^exponent`.
fn shortest_digits(x: f64) -> (Vec<u8>, i32) {
    let s = format!("{x:e}");
    let (mantissa, exp) = s.split_once('e').unwrap_or((s.as_str(), "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
    (digits, exp + 1)
}

/// The integer digits of `|x|` rounded half away from zero (ICU halfExpand on
/// the shortest representation).
fn round_to_integer_digits(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    let (digits, point) = shortest_digits(x);
    if point <= 0 {
        // Below 1: rounds up only when the first digit is right after the point.
        return if point == 0 && digits.first().is_some_and(|d| *d >= b'5') {
            "1".into()
        } else {
            "0".into()
        };
    }
    let point = point as usize;
    let mut int: Vec<u8> = digits.iter().take(point).copied().collect();
    while int.len() < point {
        int.push(b'0');
    }
    if digits.get(point).is_some_and(|d| *d >= b'5') {
        let mut i = int.len();
        loop {
            if i == 0 {
                int.insert(0, b'1');
                break;
            }
            i -= 1;
            if int[i] == b'9' {
                int[i] = b'0';
            } else {
                int[i] += 1;
                break;
            }
        }
    }
    String::from_utf8(int).unwrap_or_else(|_| "0".into())
}

/// Inserts group separators: groups of three, or 3-then-2 for en-IN.
fn group(int: &str, indian: bool) -> String {
    let b = int.as_bytes();
    let mut parts: Vec<&str> = Vec::new();
    let mut end = b.len();
    let mut size = 3;
    while end > size {
        parts.push(&int[end - size..end]);
        end -= size;
        if indian {
            size = 2;
        }
    }
    parts.push(&int[..end]);
    parts.reverse();
    parts.join(",")
}

/// `new Intl.NumberFormat(locale, { style: "currency", currency,
/// maximumFractionDigits: 0 }).format(n)`. An ill-formed currency code
/// throws `RangeError: Invalid currency code : <code>` like V8.
pub fn format_currency(n: f64, locale: &str, currency: &str) -> Result<String, JsError> {
    if !well_formed_currency(currency) {
        return Err(JsError::new(
            "RangeError",
            format!("Invalid currency code : {currency}"),
        ));
    }
    let code = currency.to_ascii_uppercase();
    let loc = Locale::from_tag(locale);
    let symbol = loc.symbol(&code);
    let negative = n.is_sign_negative() && !n.is_nan();
    let number = if n.is_nan() {
        loc.nan().to_string()
    } else if n.is_infinite() {
        "∞".to_string()
    } else {
        group(&round_to_integer_digits(n.abs()), loc == Locale::EnIn)
    };
    // ICU currency spacing: a no-break space between a symbol ending in a
    // letter and a following digit.
    let spaced = symbol.chars().last().is_some_and(char::is_alphabetic)
        && number.starts_with(|c: char| c.is_ascii_digit());
    let sign = if negative { "-" } else { "" };
    let space = if spaced { "\u{a0}" } else { "" };
    Ok(format!("{sign}{symbol}{space}{number}"))
}

/// `x.toFixed(digits)`.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    crate::services::budget::compat::js_to_fixed(x, digits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Locale per currency, as `CURRENCY_LOCALE` in context.builder.ts.
    fn locale_of(c: &str) -> &'static str {
        match c {
            "INR" => "en-IN",
            "USD" => "en-US",
            "NTD" | "TWD" => "zh-TW",
            "GBP" => "en-GB",
            "EUR" => "en-IE",
            "SGD" => "en-SG",
            "JPY" => "ja-JP",
            _ => "en-US",
        }
    }

    fn num(v: &Value) -> f64 {
        match v {
            Value::String(s) if s == "-0" => -0.0,
            Value::String(s) if s == "NaN" => f64::NAN,
            Value::String(s) if s == "Infinity" => f64::INFINITY,
            Value::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
            other => other.as_f64().expect("number"),
        }
    }

    /// Vectors produced by V8 (Node 24, ICU 78) running the same calls.
    #[test]
    fn matches_v8() {
        let data = include_str!("intl_v8.jsonl");
        let mut n = 0;
        for line in data.lines() {
            let row: Vec<Value> = serde_json::from_str(line).expect("row");
            let (kind, x, want) = (
                row[0].as_str().expect("kind"),
                num(&row[1]),
                row[2].as_str().expect("want"),
            );
            let got = if kind == "toFixed1" {
                to_fixed(x, 1)
            } else {
                format_currency(x, locale_of(kind), kind).expect("format")
            };
            assert_eq!(got, want, "{kind} {x:?}");
            n += 1;
        }
        assert!(n > 6500);
    }

    #[test]
    fn invalid_currency() {
        let e = format_currency(1.0, "en-US", "constructor").expect_err("invalid");
        assert_eq!(
            e.to_js_string(),
            "RangeError: Invalid currency code : constructor"
        );
        assert!(format_currency(1.0, "en-US", "ab").is_err());
    }
}
