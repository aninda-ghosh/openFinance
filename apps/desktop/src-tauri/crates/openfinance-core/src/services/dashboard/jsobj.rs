//! A plain JS object used as a string-keyed record (`Record<string, T>`),
//! for the ordering `Object.entries` / `Object.values` give it: array-index
//! keys ("0", "42", …) first in ascending numeric order, then every other key
//! in insertion order. Assigning an existing key keeps its position.
//!
//! Keys naming `Object.prototype` members (`__proto__`, `toString`, …) are
//! treated as ordinary keys; Node would read the inherited member instead
//! (see QUIRKS.md, Wave 2 — dashboard).

use std::collections::HashMap;

#[derive(Debug, Clone)]
pub(crate) struct JsRecord<V> {
    entries: Vec<(String, V)>,
    index: HashMap<String, usize>,
}

impl<V> Default for JsRecord<V> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
        }
    }
}

/// ECMAScript "array index": a canonical numeric string for an integer in
/// `0 ..= 2^32 - 2`.
fn is_array_index(k: &str) -> bool {
    if k.is_empty() || k.len() > 10 || !k.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if k.len() > 1 && k.starts_with('0') {
        return false;
    }
    k.parse::<u64>().is_ok_and(|n| n < u64::from(u32::MAX))
}

impl<V> JsRecord<V> {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn get(&self, key: &str) -> Option<&V> {
        self.index.get(key).map(|&i| &self.entries[i].1)
    }

    pub(crate) fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        match self.index.get(key) {
            Some(&i) => Some(&mut self.entries[i].1),
            None => None,
        }
    }

    /// `obj[key] = value`.
    pub(crate) fn set(&mut self, key: &str, value: V) {
        match self.index.get(key) {
            Some(&i) => self.entries[i].1 = value,
            None => {
                self.index.insert(key.to_string(), self.entries.len());
                self.entries.push((key.to_string(), value));
            }
        }
    }

    /// `Object.entries(obj)`, in JS property order.
    pub(crate) fn into_entries(self) -> Vec<(String, V)> {
        let (mut ints, rest): (Vec<_>, Vec<_>) = self
            .entries
            .into_iter()
            .partition(|(k, _)| is_array_index(k));
        ints.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(0));
        ints.extend(rest);
        ints
    }

    /// `Object.values(obj)`, in JS property order.
    pub(crate) fn values(&self) -> Vec<&V> {
        let mut ints: Vec<(u64, &V)> = Vec::new();
        let mut rest: Vec<&V> = Vec::new();
        for (k, v) in &self.entries {
            if is_array_index(k) {
                ints.push((k.parse::<u64>().unwrap_or(0), v));
            } else {
                rest.push(v);
            }
        }
        ints.sort_by_key(|(n, _)| *n);
        ints.into_iter().map(|(_, v)| v).chain(rest).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_like_a_js_object() {
        let mut r = JsRecord::new();
        r.set("b", 1);
        r.set("10", 2);
        r.set("a", 3);
        r.set("2", 4);
        r.set("01", 5);
        r.set("4294967295", 6);
        r.set("b", 7);
        let keys: Vec<String> = r.clone().into_entries().into_iter().map(|e| e.0).collect();
        assert_eq!(keys, ["2", "10", "b", "a", "01", "4294967295"]);
        assert_eq!(
            r.values().into_iter().copied().collect::<Vec<_>>(),
            [4, 2, 7, 3, 5, 6]
        );
    }
}
