//! Port of `apps/server/src/utils/paths.ts` (Wave 0) plus the `DB_PATH`
//! default from `db/index.ts`.

use std::path::{Component, Path, PathBuf};

/// `path.resolve(p)`: absolute (against `cwd`) and lexically normalised.
pub fn resolve(cwd: &Path, p: &Path) -> PathBuf {
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    };
    let mut out = PathBuf::new();
    for comp in joined.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `process.env.DB_PATH ?? path.resolve("openfinance.db")` (db/index.ts).
pub fn db_path(db_path_env: Option<&str>, cwd: &Path) -> PathBuf {
    match db_path_env {
        Some(p) => PathBuf::from(p),
        None => resolve(cwd, Path::new("openfinance.db")),
    }
}

/// `DATA_DIR`: the directory holding the database when `DB_PATH` is set (and
/// non-empty), else the working directory. Uploads live in
/// `DATA_DIR/uploads/documents`, chat memories in `DATA_DIR/chat-memories`.
pub fn data_dir(db_path_env: Option<&str>, cwd: &Path) -> PathBuf {
    match db_path_env {
        Some(p) if !p.is_empty() => {
            let abs = resolve(cwd, Path::new(p));
            abs.parent().map(Path::to_path_buf).unwrap_or(abs)
        }
        _ => cwd.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_semantics() {
        let cwd = Path::new("/work");
        assert_eq!(
            data_dir(Some("/a/b/openfinance.db"), cwd),
            PathBuf::from("/a/b")
        );
        assert_eq!(data_dir(Some("rel/x.db"), cwd), PathBuf::from("/work/rel"));
        assert_eq!(data_dir(Some("../x.db"), cwd), PathBuf::from("/"));
        assert_eq!(data_dir(Some(""), cwd), PathBuf::from("/work"));
        assert_eq!(data_dir(None, cwd), PathBuf::from("/work"));
        assert_eq!(db_path(None, cwd), PathBuf::from("/work/openfinance.db"));
    }
}
