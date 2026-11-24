//! Port of `apps/server/src/services/document.service.ts`. Owner: Wave 1 (data).
//!
//! Uploaded documents live in `DATA_DIR/uploads/documents` as
//! `doc_<nanoid(12)><ext>`, OFE1-encrypted with the file key (the desktop
//! passcode). Node and Rust read and write the very same files.
//!
//! The functions take the connection and the uploads folder explicitly so the
//! investments routes (`/api/investments/:id/documents`, Wave 2) and the
//! life-insurance service (Wave 1 policies) can reuse them.

pub mod nodepath;

use std::path::{Path, PathBuf};

use rusqlite::{params_from_iter, Connection};
use serde_json::{Map, Value};

use crate::crypto::{self, FileCrypto};
use crate::error::{ApiError, ApiResult};
use crate::ids;
use crate::js::now_iso;
use crate::json::from_sql;
use crate::state::AppState;

/// `UPLOADS_DIR` for a given `DATA_DIR`: `path.join(DATA_DIR, "uploads", "documents")`.
pub fn uploads_dir(data_dir: &Path) -> PathBuf {
    let base = data_dir.to_string_lossy();
    PathBuf::from(nodepath::join_str(&[&base, "uploads", "documents"]))
}

/// `UPLOADS_DIR` of this process.
pub fn uploads_dir_of(state: &AppState) -> PathBuf {
    uploads_dir(&state.config().data_dir)
}

/// `path.join(UPLOADS_DIR, fileName)`, lexically normalised like Node.
pub fn file_path(uploads: &Path, file_name: &str) -> PathBuf {
    nodepath::join(uploads, file_name)
}

/// `fs.existsSync(p)`: false on any error.
pub fn exists_sync(p: &Path) -> bool {
    std::fs::metadata(p).is_ok()
}

/// `investment_documents` columns, in schema order (`db.select()` order).
pub const COLUMNS: [&str; 11] = [
    "id",
    "investment_id",
    "account_id",
    "life_insurance_id",
    "name",
    "file_name",
    "file_size",
    "mime_type",
    "notes",
    "created_at",
    "updated_at",
];

/// A form value as `createDocument` receives it. Strings bind; a `File`
/// object (a form field sent as a file) makes better-sqlite3 throw
/// "SQLite3 can only bind numbers, strings, bigints, buffers, and null",
/// which Node only hits after the upload was already written to disk.
#[derive(Debug, Clone, PartialEq)]
pub enum FormText {
    Text(String),
    File,
}

impl FormText {
    /// JS truthiness: a non-empty string or any object.
    fn truthy(&self) -> bool {
        match self {
            FormText::Text(s) => !s.is_empty(),
            FormText::File => true,
        }
    }
}

/// `value || null` for an optional form value.
pub fn or_null(v: Option<FormText>) -> Option<FormText> {
    v.filter(FormText::truthy)
}

/// Arguments of `createDocument(parentId, name, fileBuffer, originalName, mimeType, size, notes)`.
#[derive(Debug, Clone)]
pub struct NewDocument {
    pub investment_id: Option<FormText>,
    pub account_id: Option<FormText>,
    pub life_insurance_id: Option<FormText>,
    /// `name` as passed (the routes pass `name || file.name`).
    pub name: Option<FormText>,
    pub data: Vec<u8>,
    pub original_name: String,
    pub mime_type: String,
    pub size: f64,
    pub notes: Option<FormText>,
}

const BIND_ERROR: &str =
    "TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null";

fn bind_text(v: Option<FormText>) -> ApiResult<Option<String>> {
    match v {
        None => Ok(None),
        Some(FormText::Text(s)) => Ok(Some(s)),
        Some(FormText::File) => Err(ApiError::internal(BIND_ERROR)),
    }
}

/// `createDocument`: writes the encrypted upload, then inserts the row and
/// returns it (`.returning()`).
pub fn create_document(
    conn: &Connection,
    uploads: &Path,
    file_crypto: &FileCrypto,
    doc: NewDocument,
) -> ApiResult<Value> {
    // ensureUploadsDir()
    if !exists_sync(uploads) {
        std::fs::create_dir_all(uploads).map_err(ApiError::internal)?;
    }

    let ext = nodepath::extname(&doc.original_name);
    let extension = if ext.is_empty() {
        ".dat".to_string()
    } else {
        ext
    };
    let disk_file_name = format!("doc_{}{}", ids::nanoid_sized(12), extension);
    let path = file_path(uploads, &disk_file_name);

    let to_write = file_crypto.encrypt_buffer(&doc.data);
    std::fs::write(&path, to_write).map_err(ApiError::internal)?;

    // `name || originalName`, `notes || null`, `parentId.x || null`.
    let name = match or_null(doc.name) {
        Some(v) => v,
        None => FormText::Text(doc.original_name.clone()),
    };
    let investment_id = bind_text(or_null(doc.investment_id))?;
    let account_id = bind_text(or_null(doc.account_id))?;
    let life_insurance_id = bind_text(or_null(doc.life_insurance_id))?;
    let name = bind_text(Some(name))?;
    let notes = bind_text(or_null(doc.notes))?;

    let id = ids::nanoid();
    let created_at = now_iso();
    let updated_at = now_iso();
    let sql = format!(
        "insert into \"investment_documents\" ({}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning {}",
        quoted(&COLUMNS),
        quoted(&COLUMNS)
    );
    let params: Vec<rusqlite::types::Value> = vec![
        id.into(),
        opt(investment_id),
        opt(account_id),
        opt(life_insurance_id),
        opt(name),
        disk_file_name.into(),
        doc.size.into(),
        doc.mime_type.into(),
        opt(notes),
        created_at.into(),
        updated_at.into(),
    ];
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params_from_iter(params))?;
    match rows.next()? {
        Some(row) => Ok(Value::Object(row_object(row, &COLUMNS)?)),
        None => Err(ApiError::internal("insert returned no row")),
    }
}

fn opt(v: Option<String>) -> rusqlite::types::Value {
    match v {
        Some(s) => s.into(),
        None => rusqlite::types::Value::Null,
    }
}

fn quoted(cols: &[&str]) -> String {
    cols.iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

fn row_object(row: &rusqlite::Row<'_>, keys: &[&str]) -> rusqlite::Result<Map<String, Value>> {
    let mut obj = Map::new();
    for (i, k) in keys.iter().enumerate() {
        obj.insert((*k).to_string(), from_sql(row.get_ref(i)?));
    }
    Ok(obj)
}

/// `migratePlaintextDocuments()`: encrypts plaintext uploads (web mode only;
/// returns 0 on desktop). Called by `jobs.rs` on startup.
pub fn migrate_plaintext_documents(state: &AppState) -> ApiResult<u64> {
    migrate_plaintext_in(&uploads_dir_of(state), state.file_crypto())
}

fn migrate_plaintext_in(uploads: &Path, file_crypto: &FileCrypto) -> ApiResult<u64> {
    if file_crypto.desktop() {
        return Ok(0);
    }
    let Some(key) = file_crypto.key() else {
        return Ok(0);
    };
    if !exists_sync(uploads) {
        return Ok(0);
    }
    let mut migrated = 0;
    for name in read_dir_sorted(uploads)? {
        let path = file_path(uploads, &name);
        let meta = std::fs::metadata(&path).map_err(ApiError::internal)?;
        if !meta.is_file() {
            continue;
        }
        let data = std::fs::read(&path).map_err(ApiError::internal)?;
        if crypto::is_encrypted_file(&data) {
            continue;
        }
        std::fs::write(&path, crypto::encrypt_buffer(&data, Some(key)))
            .map_err(ApiError::internal)?;
        migrated += 1;
    }
    Ok(migrated)
}

/// `fs.readdirSync(dir)`: entry names sorted bytewise (libuv's scandir sorts
/// with strcmp).
pub fn read_dir_sorted(dir: &Path) -> ApiResult<Vec<String>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(ApiError::internal)? {
        let entry = entry.map_err(ApiError::internal)?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Ok(names)
}

/// Filters of `listAllDocuments` (each already `|| null`).
#[derive(Debug, Clone, Default)]
pub struct DocumentFilters {
    pub investment_id: Option<String>,
    pub account_id: Option<String>,
    pub life_insurance_id: Option<String>,
}

/// Selected fields of `listAllDocuments`, in its object order:
/// (output key, SQL expression).
const LIST_FIELDS: [(&str, &str); 28] = [
    ("id", "\"investment_documents\".\"id\""),
    (
        "investment_id",
        "\"investment_documents\".\"investment_id\"",
    ),
    ("account_id", "\"investment_documents\".\"account_id\""),
    (
        "life_insurance_id",
        "\"investment_documents\".\"life_insurance_id\"",
    ),
    ("name", "\"investment_documents\".\"name\""),
    ("file_name", "\"investment_documents\".\"file_name\""),
    ("file_size", "\"investment_documents\".\"file_size\""),
    ("mime_type", "\"investment_documents\".\"mime_type\""),
    ("notes", "\"investment_documents\".\"notes\""),
    ("created_at", "\"investment_documents\".\"created_at\""),
    ("updated_at", "\"investment_documents\".\"updated_at\""),
    ("investment_name", "\"investments\".\"name\""),
    ("investment_asset_type", "\"investments\".\"asset_type\""),
    ("investment_currency", "\"investments\".\"currency\""),
    (
        "investment_purchase_value",
        "\"investments\".\"purchase_value\"",
    ),
    ("investment_units", "\"investments\".\"units\""),
    (
        "investment_current_value",
        "\"investments\".\"current_value\"",
    ),
    (
        "investment_purchase_date",
        "\"investments\".\"purchase_date\"",
    ),
    ("account_name", "\"accounts\".\"name\""),
    ("account_type", "\"accounts\".\"type\""),
    ("account_currency", "\"accounts\".\"currency\""),
    ("account_balance", "\"accounts\".\"balance\""),
    ("account_institution", "\"accounts\".\"institution\""),
    ("life_insurance_name", "\"life_insurance\".\"name\""),
    (
        "life_insurance_insured_person",
        "\"life_insurance\".\"insured_person\"",
    ),
    ("life_insurance_provider", "\"life_insurance\".\"provider\""),
    ("life_insurance_currency", "\"life_insurance\".\"currency\""),
    (
        "life_insurance_coverage_amount",
        "\"life_insurance\".\"coverage_amount\"",
    ),
];

/// `life_insurance_renewal_date` closes the list (kept apart so the array
/// above stays readable).
const LAST_FIELD: (&str, &str) = (
    "life_insurance_renewal_date",
    "\"life_insurance\".\"renewal_date\"",
);

/// `listAllDocuments(filters)`: documents left-joined with their investment,
/// account and life-insurance metadata. No ORDER BY, like Node.
pub fn list_all_documents(conn: &Connection, filters: &DocumentFilters) -> ApiResult<Vec<Value>> {
    let fields: Vec<(&str, &str)> = LIST_FIELDS
        .iter()
        .copied()
        .chain(std::iter::once(LAST_FIELD))
        .collect();
    let select = fields
        .iter()
        .map(|(_, e)| *e)
        .collect::<Vec<_>>()
        .join(", ");
    let mut sql = format!(
        "select {select} from \"investment_documents\" \
         left join \"investments\" on \"investment_documents\".\"investment_id\" = \"investments\".\"id\" \
         left join \"accounts\" on \"investment_documents\".\"account_id\" = \"accounts\".\"id\" \
         left join \"life_insurance\" on \"investment_documents\".\"life_insurance_id\" = \"life_insurance\".\"id\""
    );
    let mut conditions = Vec::new();
    let mut params = Vec::new();
    if let Some(v) = filters.investment_id.as_ref().filter(|s| !s.is_empty()) {
        conditions.push("\"investment_documents\".\"investment_id\" = ?");
        params.push(v.clone());
    }
    if let Some(v) = filters.account_id.as_ref().filter(|s| !s.is_empty()) {
        conditions.push("\"investment_documents\".\"account_id\" = ?");
        params.push(v.clone());
    }
    if let Some(v) = filters.life_insurance_id.as_ref().filter(|s| !s.is_empty()) {
        conditions.push("\"investment_documents\".\"life_insurance_id\" = ?");
        params.push(v.clone());
    }
    if !conditions.is_empty() {
        sql.push_str(" where (");
        sql.push_str(&conditions.join(" and "));
        sql.push(')');
    }
    let keys: Vec<&str> = fields.iter().map(|(k, _)| *k).collect();
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params_from_iter(params))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(Value::Object(row_object(row, &keys)?));
    }
    Ok(out)
}

/// `listDocuments(investmentId)`.
pub fn list_documents(conn: &Connection, investment_id: &str) -> ApiResult<Vec<Value>> {
    list_all_documents(
        conn,
        &DocumentFilters {
            investment_id: Some(investment_id.to_string()),
            ..Default::default()
        },
    )
}

/// `getDocumentById(docId)`: the full row, or `None`.
pub fn get_document_by_id(
    conn: &Connection,
    doc_id: &str,
) -> ApiResult<Option<Map<String, Value>>> {
    let sql = format!(
        "select {} from \"investment_documents\" where \"investment_documents\".\"id\" = ? limit 1",
        quoted(&COLUMNS)
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([doc_id])?;
    match rows.next()? {
        Some(row) => Ok(Some(row_object(row, &COLUMNS)?)),
        None => Ok(None),
    }
}

/// `deleteDocument(docId)`: 404 when missing; removes the file (if present)
/// and then the row. Not transactional, like Node.
pub fn delete_document(conn: &Connection, uploads: &Path, doc_id: &str) -> ApiResult<()> {
    let Some(doc) = get_document_by_id(conn, doc_id)? else {
        return Err(ApiError::service(404, "Document not found"));
    };
    let path = file_path(uploads, &file_name_of(&doc));
    if exists_sync(&path) {
        std::fs::remove_file(&path).map_err(ApiError::internal)?;
    }
    conn.execute(
        "delete from \"investment_documents\" where \"investment_documents\".\"id\" = ?",
        [doc_id],
    )?;
    Ok(())
}

/// `doc.file_name` as the string `path.join` would see. Rows always hold text
/// here (NOT NULL TEXT column).
fn file_name_of(doc: &Map<String, Value>) -> String {
    match doc.get("file_name") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// What `GET /documents/:docId` serves.
#[derive(Debug)]
pub enum DocumentFile {
    /// No row: `404 {"error":"Document not found"}`.
    NotFound,
    /// Row without a file on disk: `404 {"error":"Physical file not found"}`.
    PhysicalMissing,
    /// The decrypted bytes plus the row's `name` and `mime_type`.
    Found {
        data: Vec<u8>,
        name: String,
        mime_type: String,
    },
}

/// The shared body of `GET /api/documents/:docId` and
/// `GET /api/investments/documents/:docId`.
pub fn read_document(
    conn: &Connection,
    uploads: &Path,
    file_crypto: &FileCrypto,
    doc_id: &str,
) -> ApiResult<DocumentFile> {
    let Some(doc) = get_document_by_id(conn, doc_id)? else {
        return Ok(DocumentFile::NotFound);
    };
    let path = file_path(uploads, &file_name_of(&doc));
    if !exists_sync(&path) {
        return Ok(DocumentFile::PhysicalMissing);
    }
    let raw = std::fs::read(&path).map_err(ApiError::internal)?;
    let data = file_crypto.decrypt_buffer(&raw);
    let text = |k: &str| match doc.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => "null".to_string(),
        Some(other) => other.to_string(),
    };
    Ok(DocumentFile::Found {
        data,
        name: text("name"),
        mime_type: text("mime_type"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("open");
        crate::db::bootstrap::bootstrap_schema(&c).expect("bootstrap");
        c
    }

    fn new_doc(name: Option<FormText>) -> NewDocument {
        NewDocument {
            investment_id: None,
            account_id: Some(FormText::Text(String::new())),
            life_insurance_id: None,
            name,
            data: b"hello".to_vec(),
            original_name: "statement.PDF".into(),
            mime_type: "application/pdf".into(),
            size: 5.0,
            notes: Some(FormText::Text(String::new())),
        }
    }

    #[test]
    fn create_list_read_delete() {
        let c = conn();
        let dir = tempfile::tempdir().expect("tempdir");
        let uploads = uploads_dir(dir.path());
        let fc = FileCrypto::new(Some("pass".into()), true);
        let row = create_document(&c, &uploads, &fc, new_doc(None)).expect("create");
        let file_name = row["file_name"].as_str().expect("file_name").to_string();
        assert!(file_name.starts_with("doc_") && file_name.ends_with(".PDF"));
        assert_eq!(file_name.len(), "doc_".len() + 12 + 4);
        assert_eq!(row["name"], "statement.PDF");
        assert_eq!(row["account_id"], Value::Null);
        assert_eq!(row["notes"], Value::Null);
        assert_eq!(row["file_size"], 5);
        let on_disk = std::fs::read(uploads.join(&file_name)).expect("file");
        assert!(crypto::is_encrypted_file(&on_disk));

        let id = row["id"].as_str().expect("id").to_string();
        let listed = list_all_documents(&c, &DocumentFilters::default()).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].as_object().map(|o| o.len()), Some(29));
        match read_document(&c, &uploads, &fc, &id).expect("read") {
            DocumentFile::Found { data, .. } => assert_eq!(data, b"hello"),
            other => panic!("unexpected {other:?}"),
        }
        delete_document(&c, &uploads, &id).expect("delete");
        assert!(!uploads.join(&file_name).exists());
        assert!(matches!(
            delete_document(&c, &uploads, &id),
            Err(ApiError::Service {
                status: Some(404),
                ..
            })
        ));
    }

    #[test]
    fn file_field_as_name_fails_after_writing() {
        let c = conn();
        let dir = tempfile::tempdir().expect("tempdir");
        let uploads = uploads_dir(dir.path());
        let fc = FileCrypto::new(Some("pass".into()), true);
        let err = create_document(&c, &uploads, &fc, new_doc(Some(FormText::File)));
        assert!(matches!(err, Err(ApiError::Internal(_))));
        assert_eq!(read_dir_sorted(&uploads).expect("dir").len(), 1);
    }

    #[test]
    fn migration_only_outside_desktop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let uploads = uploads_dir(dir.path());
        std::fs::create_dir_all(&uploads).expect("mkdir");
        std::fs::write(uploads.join("a.txt"), b"plain").expect("write");
        let desktop = FileCrypto::new(Some("k".into()), true);
        assert_eq!(migrate_plaintext_in(&uploads, &desktop).expect("m"), 0);
        let web = FileCrypto::new(Some("k".into()), false);
        assert_eq!(migrate_plaintext_in(&uploads, &web).expect("m"), 1);
        assert_eq!(migrate_plaintext_in(&uploads, &web).expect("m"), 0);
        let data = std::fs::read(uploads.join("a.txt")).expect("read");
        assert_eq!(crypto::decrypt_buffer(&data, Some("k"), false), b"plain");
        let nokey = FileCrypto::new(None, false);
        assert_eq!(migrate_plaintext_in(&uploads, &nokey).expect("m"), 0);
    }

    #[test]
    fn uploads_dir_shape() {
        assert_eq!(
            uploads_dir(Path::new("/data")),
            PathBuf::from("/data/uploads/documents")
        );
    }
}
