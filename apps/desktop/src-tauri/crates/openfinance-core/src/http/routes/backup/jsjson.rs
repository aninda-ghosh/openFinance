//! `JSON.stringify(value, null, 2)` with JavaScript number formatting, so the
//! exported `backup-data.json` is the text Node writes (serde_json's pretty
//! printer already matches JS for structure and string escaping; only numbers
//! differ, e.g. `1.0` vs `1` and `1e21` vs `1e+21`).

use std::io;

use serde::Serialize;
use serde_json::ser::{Formatter, PrettyFormatter};
use serde_json::Value;

/// `Number.prototype.toString()` (radix 10) for a finite double.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }
    // Shortest round-trip digits: "d.ddddde<exp>".
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        let zeros = "0".repeat((n - k) as usize);
        format!("{digits}{zeros}")
    } else if 0 < n && n <= 21 {
        let (a, b) = digits.split_at(n as usize);
        format!("{a}.{b}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{sign}{}", e.abs())
        } else {
            format!("{first}.{rest}e{sign}{}", e.abs())
        }
    }
}

/// serde_json's 2-space pretty printer with JS number output.
struct JsPretty(PrettyFormatter<'static>);

impl Formatter for JsPretty {
    fn write_i64<W: ?Sized + io::Write>(&mut self, w: &mut W, v: i64) -> io::Result<()> {
        w.write_all(number_to_string(v as f64).as_bytes())
    }
    fn write_u64<W: ?Sized + io::Write>(&mut self, w: &mut W, v: u64) -> io::Result<()> {
        w.write_all(number_to_string(v as f64).as_bytes())
    }
    fn write_f64<W: ?Sized + io::Write>(&mut self, w: &mut W, v: f64) -> io::Result<()> {
        w.write_all(number_to_string(v).as_bytes())
    }
    fn begin_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_array(w)
    }
    fn end_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_array(w)
    }
    fn begin_array_value<W: ?Sized + io::Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.0.begin_array_value(w, first)
    }
    fn end_array_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_array_value(w)
    }
    fn begin_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_object(w)
    }
    fn end_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_object(w)
    }
    fn begin_object_key<W: ?Sized + io::Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.0.begin_object_key(w, first)
    }
    fn begin_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.begin_object_value(w)
    }
    fn end_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.0.end_object_value(w)
    }
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> serde_json::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, JsPretty(PrettyFormatter::with_indent(b"  ")));
    value.serialize(&mut ser)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Expected strings from Node: `String(x)`.
    #[test]
    fn numbers_like_js() {
        let cases: [(f64, &str); 16] = [
            (1.0, "1"),
            (0.1 + 0.2, "0.30000000000000004"),
            (3106.1, "3106.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (-2.5, "-2.5"),
            (-0.0, "0"),
            (0.012, "0.012"),
            (9007199254740993.0, "9007199254740992"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (100.0, "100"),
        ];
        for (x, s) in cases {
            assert_eq!(number_to_string(x), s, "{x:e}");
        }
    }

    #[test]
    fn pretty_like_json_stringify() {
        let v = json!({"a": [], "b": {}, "c": [1.0, "x\u{1}\"\\/é"], "d": null, "e": {"f": true}});
        let s = String::from_utf8(stringify_pretty(&v).expect("json")).expect("utf8");
        assert_eq!(
            s,
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    \"x\\u0001\\\"\\\\/é\"\n  ],\n  \"d\": null,\n  \"e\": {\n    \"f\": true\n  }\n}"
        );
    }
}
