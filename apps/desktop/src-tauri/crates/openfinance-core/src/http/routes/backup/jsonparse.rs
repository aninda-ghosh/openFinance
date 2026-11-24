//! `JSON.parse(text)` for the backup file.
//!
//! serde_json's default number parsing is not correctly rounded (for example
//! `91750.79000000001` parses as `91750.79`), and exported backups are full of
//! such doubles, so this parser reads every number with Rust's correctly
//! rounded `str::parse::<f64>`, as V8 does. It also follows JS where serde
//! would reject the input: no nesting limit beyond [`MAX_DEPTH`], and escaped
//! lone surrogates are accepted (stored as U+FFFD, which is what
//! better-sqlite3 writes for them). Numbers beyond the double range
//! (`1e400`, Infinity in JS) become `null`; see STATUS.md.

use serde_json::{Map, Number, Value};

/// Far beyond any real backup; keeps the recursion off the stack limit.
const MAX_DEPTH: usize = 5000;

pub fn parse(text: &str) -> Result<Value, String> {
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(format!("Unexpected non-whitespace character at position {}", p.i));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn err<T>(&self, what: &str) -> Result<T, String> {
        Err(format!("{what} at position {}", self.i))
    }

    fn ws(&mut self) {
        while matches!(self.s.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn lit(&mut self, word: &[u8], v: Value) -> Result<Value, String> {
        if self.s.get(self.i..self.i + word.len()) == Some(word) {
            self.i += word.len();
            Ok(v)
        } else {
            self.err("Unexpected token")
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > MAX_DEPTH {
            return self.err("Nesting too deep");
        }
        match self.s.get(self.i) {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Value::String),
            Some(b't') => self.lit(b"true", Value::Bool(true)),
            Some(b'f') => self.lit(b"false", Value::Bool(false)),
            Some(b'n') => self.lit(b"null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.err("Unexpected token"),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, String> {
        self.i += 1;
        let mut map = Map::new();
        self.ws();
        if self.s.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(Value::Object(map));
        }
        loop {
            self.ws();
            if self.s.get(self.i) != Some(&b'"') {
                return self.err("Expected property name");
            }
            let key = self.string()?;
            self.ws();
            if self.s.get(self.i) != Some(&b':') {
                return self.err("Expected ':'");
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            map.insert(key, v);
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Value::Object(map));
                }
                _ => return self.err("Expected ',' or '}'"),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, String> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Value::Array(items));
                }
                _ => return self.err("Expected ',' or ']'"),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let part = match self.s.get(self.i..self.i + 4) {
            Some(p) => p,
            None => return self.err("Bad Unicode escape"),
        };
        let text = std::str::from_utf8(part).map_err(|e| e.to_string())?;
        if !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return self.err("Bad Unicode escape");
        }
        self.i += 4;
        u32::from_str_radix(text, 16).map_err(|e| e.to_string())
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let start = self.i;
            while let Some(&b) = self.s.get(self.i) {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.i += 1;
            }
            // The input is a &str, so this run is valid UTF-8.
            out.push_str(std::str::from_utf8(&self.s[start..self.i]).map_err(|e| e.to_string())?);
            match self.s.get(self.i) {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let Some(&e) = self.s.get(self.i) else {
                        return self.err("Unterminated string");
                    };
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            if (0xD800..0xDC00).contains(&hi)
                                && self.s.get(self.i) == Some(&b'\\')
                                && self.s.get(self.i + 1) == Some(&b'u')
                            {
                                let save = self.i;
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    let cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                                    out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                                    continue;
                                }
                                self.i = save;
                            }
                            out.push(char::from_u32(hi).unwrap_or('\u{fffd}'));
                        }
                        _ => return self.err("Bad escaped character"),
                    }
                }
                _ => return self.err("Bad control character in string literal"),
            }
        }
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.i;
        self.eat(b'-');
        match self.s.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return self.err("No number after minus sign"),
        }
        if self.eat(b'.') {
            if !self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
                return self.err("Unterminated fractional number");
            }
            self.digits();
        }
        if self.eat(b'e') || self.eat(b'E') {
            if !self.eat(b'+') {
                self.eat(b'-');
            }
            if !self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
                return self.err("Exponent part is missing a number");
            }
            self.digits();
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).map_err(|e| e.to_string())?;
        let f: f64 = text.parse().map_err(|e: std::num::ParseFloatError| e.to_string())?;
        Ok(Number::from_f64(f).map_or(Value::Null, Value::Number))
    }

    fn eat(&mut self, b: u8) -> bool {
        if self.s.get(self.i) == Some(&b) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn digits(&mut self) {
        while self.s.get(self.i).is_some_and(u8::is_ascii_digit) {
            self.i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_like_json_parse() {
        assert_eq!(
            parse(" {\"a\": [1, -0.5, 1e3, true, null, \"x\\u00e9\\n\"], \"a\": 2} ").expect("ok"),
            json!({"a": 2.0})
        );
        assert_eq!(parse("91750.79000000001").expect("ok").as_f64(), Some(91750.79000000001));
        assert_eq!(parse("0.30000000000000004").expect("ok").as_f64(), Some(0.1 + 0.2));
        assert_eq!(parse("\"\\ud83d\\ude00\"").expect("ok"), json!("😀"));
        assert_eq!(parse("\"\\ud800x\"").expect("ok"), json!("\u{fffd}x"));
        assert_eq!(parse("1e400").expect("ok"), Value::Null);
        for bad in ["", "01", "1.", "-", "[1,]", "{\"a\":1,}", "\u{feff}{}", "'a'", "\"\t\"", "nul", "{} x"] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn numbers_roundtrip_exactly() {
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for i in 0..20_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let f = if i % 2 == 0 {
                f64::from_bits(x >> 2)
            } else {
                (x % 10_000_000) as f64 / 100.0 + 0.1 * ((x >> 40) % 7) as f64
            };
            let s = super::super::jsjson::number_to_string(f);
            assert_eq!(parse(&s).expect("num").as_f64(), Some(f), "{s}");
        }
    }
}
