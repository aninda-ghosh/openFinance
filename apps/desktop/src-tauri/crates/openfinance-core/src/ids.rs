//! `nanoid()` from the `nanoid` npm package (v5 default): 21 characters from
//! the 64-symbol URL-safe alphabet, each picked by `random byte & 63`, so every
//! symbol is equally likely. Owned by Wave 0.

use rand::RngCore;

/// The npm package's `urlAlphabet`, in its order.
pub const URL_ALPHABET: &[u8; 64] =
    b"useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/// Default nanoid length.
pub const DEFAULT_SIZE: usize = 21;

/// A new 21-character id, like `nanoid()`.
pub fn nanoid() -> String {
    nanoid_sized(DEFAULT_SIZE)
}

/// Like `nanoid(size)`.
pub fn nanoid_sized(size: usize) -> String {
    let mut bytes = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| URL_ALPHABET[(b & 63) as usize] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape() {
        let id = nanoid();
        assert_eq!(id.len(), 21);
        assert!(id.bytes().all(|c| URL_ALPHABET.contains(&c)));
        assert_ne!(nanoid(), nanoid());
        let mut sorted = URL_ALPHABET.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 64);
    }
}
