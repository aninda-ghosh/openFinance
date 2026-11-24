//! `parse(buffer, { columns: true, skip_empty_lines: true, trim: true })` from
//! `csv-parse/sync` 6.x, ported from its state machine (lib/api/index.js) for
//! exactly these options: `,` delimiter, `"` quote and escape, record
//! delimiter auto-detected from the first `\r\n` / `\n` / `\r`, no BOM
//! stripping (`bom: false`), no comments, no casting, strict quotes and
//! column counts. Hand-ported rather than using the `csv` crate so the
//! accept/reject decisions and the trimming rules are the same byte for byte.
//!
//! Node only cares whether parsing throws (any error becomes "Failed to parse
//! CSV file"), so errors carry no message.

use serde_json::{Map, Value};

/// csv-parse's `timchars` for UTF-8: `\r`, `\n`, `\f`, space, tab.
fn trimable(buf: &[u8], pos: usize) -> bool {
    matches!(buf.get(pos), Some(b'\r' | b'\n' | 0x0c | b' ' | b'\t'))
}

/// `__autoDiscoverRecordDelimiter`: `\r\n`, then `\n`, then `\r`.
fn discover(buf: &[u8], pos: usize) -> Option<&'static [u8]> {
    let rest = buf.get(pos..).unwrap_or(&[]);
    if rest.starts_with(b"\r\n") {
        Some(b"\r\n")
    } else if rest.starts_with(b"\n") {
        Some(b"\n")
    } else if rest.starts_with(b"\r") {
        Some(b"\r")
    } else {
        None
    }
}

fn is_record_delimiter(rd: Option<&[u8]>, buf: &[u8], pos: usize) -> usize {
    match rd {
        Some(rd) if buf.get(pos..).is_some_and(|r| r.starts_with(rd)) => rd.len(),
        _ => 0,
    }
}

/// JS `String.prototype.trimEnd`.
fn trim_end_js(s: &str) -> &str {
    s.trim_end_matches(crate::js::is_js_whitespace)
}

#[derive(Default)]
struct Parser {
    quoting: bool,
    was_quoting: bool,
    escaping: bool,
    field: Vec<u8>,
    record: Vec<String>,
    columns: Option<Vec<String>>,
    records: Vec<Map<String, Value>>,
}

impl Parser {
    fn on_field(&mut self) {
        let text = String::from_utf8_lossy(&self.field).into_owned();
        let text = if self.was_quoting {
            text
        } else {
            trim_end_js(&text).to_string()
        };
        self.record.push(text);
        self.field.clear();
        self.was_quoting = false;
    }

    fn on_record(&mut self) -> Result<(), ()> {
        let record = std::mem::take(&mut self.record);
        match &self.columns {
            None => {
                self.columns = Some(record);
                Ok(())
            }
            Some(cols) if cols.len() != record.len() => Err(()),
            Some(cols) => {
                let mut obj = Map::new();
                for (name, value) in cols.iter().zip(record) {
                    // Duplicate names: the later value wins, in the first position.
                    obj.insert(name.clone(), Value::String(value));
                }
                self.records.push(obj);
                Ok(())
            }
        }
    }
}

/// Parses `buf` into one object per data row, keyed by the header row.
pub(crate) fn parse(buf: &[u8]) -> Result<Vec<Map<String, Value>>, ()> {
    let mut p = Parser::default();
    let mut rd: Option<&'static [u8]> = None;
    let len = buf.len();
    let mut pos = 0;
    while pos < len {
        if !p.quoting && rd.is_none() {
            rd = discover(buf, pos);
        }
        let chr = buf[pos];
        if p.escaping {
            p.escaping = false;
        } else {
            // An escape (`"`) inside a quoted field followed by a quote.
            if p.quoting && chr == b'"' && pos + 1 < len && buf[pos + 1] == b'"' {
                p.escaping = true;
                pos += 1;
                continue;
            }
            if chr == b'"' {
                if p.quoting {
                    let next = buf.get(pos + 1).copied();
                    let next_trimable = trimable(buf, pos + 1);
                    let next_delimiter = next == Some(b',');
                    let next_record_delimiter = if rd.is_none() {
                        // Auto-discovery here also records the delimiter.
                        match discover(buf, pos + 1) {
                            Some(found) => {
                                rd = Some(found);
                                true
                            }
                            None => false,
                        }
                    } else {
                        is_record_delimiter(rd, buf, pos + 1) != 0
                    };
                    if matches!(next, None | Some(0))
                        || next_delimiter
                        || next_record_delimiter
                        || next_trimable
                    {
                        p.quoting = false;
                        p.was_quoting = true;
                        pos += 1;
                        continue;
                    }
                    return Err(()); // Invalid Closing Quote
                } else if !p.field.is_empty() {
                    return Err(()); // Invalid Opening Quote
                } else {
                    p.quoting = true;
                    pos += 1;
                    continue;
                }
            }
            if !p.quoting {
                let rdl = is_record_delimiter(rd, buf, pos);
                if rdl != 0 {
                    if !(!p.was_quoting && p.record.is_empty() && p.field.is_empty()) {
                        p.on_field();
                        p.on_record()?;
                    }
                    pos += rdl;
                    continue;
                }
                if chr == b',' {
                    p.on_field();
                    pos += 1;
                    continue;
                }
            }
        }
        let lappend = p.quoting || !p.field.is_empty() || !trimable(buf, pos);
        let rappend = !p.was_quoting;
        if lappend && rappend {
            p.field.push(chr);
        } else if !trimable(buf, pos) {
            return Err(()); // non-trimable byte after a closing quote
        }
        pos += 1;
    }
    if p.quoting {
        return Err(()); // Quote Not Closed
    }
    if p.was_quoting || !p.record.is_empty() || !p.field.is_empty() {
        p.on_field();
        p.on_record()?;
    }
    Ok(p.records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rows(s: &str) -> Value {
        Value::Array(
            parse(s.as_bytes())
                .expect("parses")
                .into_iter()
                .map(Value::Object)
                .collect(),
        )
    }

    #[test]
    fn basic_and_trimmed() {
        assert_eq!(
            rows("date,payee,amount\n 2026-05-01 , Cafe ,12.5 \n"),
            json!([{"date":"2026-05-01","payee":"Cafe","amount":"12.5"}])
        );
        assert_eq!(rows(""), json!([]));
        assert_eq!(rows("a,b"), json!([]));
        assert_eq!(
            rows("a,b\r\n1,2\r\n\r\n3,4"),
            json!([{"a":"1","b":"2"},{"a":"3","b":"4"}])
        );
        assert_eq!(rows("a,b\r1,2"), json!([{"a":"1","b":"2"}]));
        // whitespace-only lines are empty lines
        assert_eq!(rows("a\n   \n1\n"), json!([{"a":"1"}]));
        // a lone comma is a record of two empty fields
        assert_eq!(rows("a,b\n,\n"), json!([{"a":"","b":""}]));
    }

    #[test]
    fn quotes() {
        assert_eq!(
            rows("a,b\n\"x, \"\"y\"\"\" , \" z \"\n"),
            json!([{"a":"x, \"y\"","b":" z "}])
        );
        assert_eq!(rows("a\n\"multi\nline\"\n"), json!([{"a":"multi\nline"}]));
        assert!(parse(b"a\nx\"y\"\n").is_err()); // opening quote mid-field
        assert!(parse(b"a\n\"x\"y\n").is_err()); // text after closing quote
        assert!(parse(b"a\n\"open\n").is_err()); // never closed
    }

    #[test]
    fn column_counts_and_duplicates() {
        assert!(parse(b"a,b\n1\n").is_err());
        assert!(parse(b"a,b\n1,2,3\n").is_err());
        let v = rows("a,b,a\n1,2,3\n");
        assert_eq!(v, json!([{"a":"3","b":"2"}]));
        let keys: Vec<_> = v[0]
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        assert_eq!(keys, vec!["a", "b"]);
    }

    #[test]
    fn bom_is_kept() {
        let v = rows("\u{feff}date,amount\n2026-01-01,5\n");
        assert_eq!(v, json!([{"\u{feff}date":"2026-01-01","amount":"5"}]));
        assert!(parse("\u{feff}\"date\"\n1\n".as_bytes()).is_err());
    }
}
