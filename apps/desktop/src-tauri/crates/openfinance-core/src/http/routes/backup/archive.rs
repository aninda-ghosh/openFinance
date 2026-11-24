//! ZIP reading and writing with the `zip` crate, shaped like the `adm-zip`
//! calls in backup.ts: entry names decoded as UTF-8 regardless of the EFS
//! flag (adm-zip's default decoder), `getEntry(name)` returning the last
//! entry of that name, `isDirectory` meaning the name ends in `/` or `\`.

use std::io::{Cursor, Read, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// One central-directory entry.
#[derive(Debug, Clone)]
pub struct Entry {
    index: usize,
    pub name: String,
}

impl Entry {
    /// adm-zip `entry.isDirectory`.
    pub fn is_directory(&self) -> bool {
        self.name.ends_with('/') || self.name.ends_with('\\')
    }
}

/// An opened archive (`new AdmZip(buffer)`).
pub struct Archive {
    zip: ZipArchive<Cursor<Vec<u8>>>,
    entries: Vec<Entry>,
}

impl Archive {
    /// Parses the central directory; `Err` where adm-zip would throw.
    pub fn open(data: Vec<u8>) -> Result<Self, String> {
        let mut zip = ZipArchive::new(Cursor::new(data)).map_err(|e| e.to_string())?;
        let mut entries = Vec::with_capacity(zip.len());
        for index in 0..zip.len() {
            let file = zip.by_index_raw(index).map_err(|e| e.to_string())?;
            entries.push(Entry {
                index,
                name: String::from_utf8_lossy(file.name_raw()).into_owned(),
            });
        }
        Ok(Self { zip, entries })
    }

    /// `zip.getEntries()`, in central-directory order.
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// `zip.getEntry(name)`: the last entry with exactly that name.
    pub fn entry(&self, name: &str) -> Option<Entry> {
        self.entries.iter().rev().find(|e| e.name == name).cloned()
    }

    /// `entry.getData()`: the decompressed, CRC-checked bytes.
    pub fn data(&mut self, entry: &Entry) -> Result<Vec<u8>, String> {
        if entry.is_directory() {
            return Ok(Vec::new());
        }
        let mut file = self.zip.by_index(entry.index).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        file.read_to_end(&mut out).map_err(|e| e.to_string())?;
        Ok(out)
    }
}

/// `new AdmZip()` + `addFile(name, data)` for each file + `toBuffer()`
/// (deflated entries, like adm-zip, in adm-zip's sorted order).
pub fn write(files: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut sorted: Vec<&(String, Vec<u8>)> = files.iter().collect();
    sort_entries(&mut sorted)?;
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for (name, data) in sorted {
        zip.start_file(name.as_str(), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(data).map_err(|e| e.to_string())?;
    }
    let cursor = zip.finish().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

/// adm-zip's `sortEntries()` in `toBuffer()`: a stable sort by
/// `a.entryName.toLowerCase().localeCompare(b.entryName.toLowerCase())`.
/// Node's default collator is ICU en-US (root collation, tertiary strength),
/// which ICU4X's compiled root data reproduces.
fn sort_entries(entries: &mut [&(String, Vec<u8>)]) -> Result<(), String> {
    if entries.len() <= 1 {
        return Ok(());
    }
    let collator = icu_collator::Collator::try_new(
        Default::default(),
        icu_collator::options::CollatorOptions::default(),
    )
    .map_err(|e| e.to_string())?;
    entries.sort_by(|a, b| collator.compare(&a.0.to_lowercase(), &b.0.to_lowercase()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_like_adm_zip() {
        let names = [
            "documents/doc_compat000001.pdf",
            "documents/doc_DKtFeeOPfgDx.txt",
            "documents/doc_9HdsA1OfMoRF.txt",
            "backup-data.json",
            "documents/doc-x.txt",
            "documents/doc_a.b",
            "documents/doc_ab",
            "documents/Doc_AB",
            "documents/doc_é.txt",
            "documents/doc_e.txt",
            "documents/doc_f.txt",
            "documents/doc__x",
            "documents/doc.x",
        ];
        let files: Vec<(String, Vec<u8>)> =
            names.iter().map(|n| (n.to_string(), Vec::new())).collect();
        let a = Archive::open(write(&files).expect("write")).expect("open");
        let got: Vec<&str> = a.entries().iter().map(|e| e.name.as_str()).collect();
        // The order adm-zip 0.5.17 writes these in (Node 24.21, ICU 78.3).
        assert_eq!(
            got,
            [
                "backup-data.json",
                "documents/doc__x",
                "documents/doc_9HdsA1OfMoRF.txt",
                "documents/doc_a.b",
                "documents/doc_ab",
                "documents/Doc_AB",
                "documents/doc_compat000001.pdf",
                "documents/doc_DKtFeeOPfgDx.txt",
                "documents/doc_e.txt",
                "documents/doc_é.txt",
                "documents/doc_f.txt",
                "documents/doc-x.txt",
                "documents/doc.x",
            ]
        );
    }

    #[test]
    fn roundtrip() {
        let files = vec![
            ("backup-data.json".to_string(), b"{\"data\":{}}".to_vec()),
            ("documents/doc_a.pdf".to_string(), vec![0u8; 1000]),
            ("documents/empty".to_string(), Vec::new()),
        ];
        let bytes = write(&files).expect("write");
        let mut a = Archive::open(bytes).expect("open");
        let names: Vec<&str> = a.entries().iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            ["backup-data.json", "documents/doc_a.pdf", "documents/empty"]
        );
        let e = a.entry("documents/doc_a.pdf").expect("entry");
        assert_eq!(a.data(&e).expect("data"), vec![0u8; 1000]);
        assert!(Archive::open(Vec::new()).is_err());
        assert!(Archive::open(b"not a zip".to_vec()).is_err());
    }
}
