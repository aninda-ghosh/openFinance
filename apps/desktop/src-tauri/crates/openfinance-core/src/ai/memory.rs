//! Port of `apps/server/src/ai/chat-memory.ts`: one markdown file per
//! conversation in `DATA_DIR/chat-memories/<id>.md`, stored as an
//! `encryptString` payload (base64 OFE1 with the file key), so Node and Rust
//! read each other's files. Contents are never logged.

use std::path::{Path, PathBuf};

use crate::services::document::nodepath;
use crate::state::AppState;

/// `MEMORIES_DIR`.
pub fn memories_dir(data_dir: &Path) -> PathBuf {
    nodepath::join(data_dir, "chat-memories")
}

/// `filePath(conversationId)`: `path.join(MEMORIES_DIR, `${id}.md`)` (Node's
/// lexical join: an id like `../x` or `/x` stays relative to the directory
/// the way `path.join` resolves it).
pub fn file_path(data_dir: &Path, conversation_id: &str) -> PathBuf {
    nodepath::join(&memories_dir(data_dir), &format!("{conversation_id}.md"))
}

/// `fs.readFile(p, "utf-8")`.
async fn read_utf8(p: &Path) -> std::io::Result<String> {
    let bytes = blocking(p, |p| std::fs::read(p)).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Runs a std::fs call on the blocking pool (`fs.promises`).
async fn blocking<T: Send + 'static>(
    p: &Path,
    f: impl FnOnce(&Path) -> std::io::Result<T> + Send + 'static,
) -> std::io::Result<T> {
    let p = p.to_path_buf();
    tokio::task::spawn_blocking(move || f(&p))
        .await
        .map_err(std::io::Error::other)?
}

/// `readMemory(conversationId)`: the decrypted, trimmed text, or `None`.
pub async fn read_memory(state: &AppState, conversation_id: &str) -> Option<String> {
    let fp = file_path(&state.config().data_dir, conversation_id);
    let raw = read_utf8(&fp).await.ok()?;
    let content = state.file_crypto().decrypt_string(&raw);
    let trimmed = crate::js::js_trim(&content);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// `new Date().toISOString().slice(0, 19).replace("T", " ")`.
fn timestamp() -> String {
    crate::js::now_iso()
        .chars()
        .take(19)
        .collect::<String>()
        .replacen('T', " ", 1)
}

/// The text `appendExchange` adds.
pub fn exchange_text(timestamp: &str, user_message: &str, assistant_message: &str) -> String {
    [
        "---".to_string(),
        format!(
            "**[{timestamp}] User:** {}",
            crate::js::js_trim(user_message)
        ),
        String::new(),
        format!("**Assistant:** {}", crate::js::js_trim(assistant_message)),
        String::new(),
    ]
    .join("\n")
}

/// `appendExchange(conversationId, user, assistant)`. Errors are returned
/// (the caller ignores them, like Node's `.catch(() => {})`).
pub async fn append_exchange(
    state: &AppState,
    conversation_id: &str,
    user_message: &str,
    assistant_message: &str,
) -> std::io::Result<()> {
    let data_dir = &state.config().data_dir;
    blocking(&memories_dir(data_dir), |p| std::fs::create_dir_all(p)).await?;
    let fp = file_path(data_dir, conversation_id);
    let existing = match read_utf8(&fp).await {
        Ok(raw) => state.file_crypto().decrypt_string(&raw),
        // File doesn't exist yet — start fresh
        Err(_) => format!("# Chat Memory: {conversation_id}\n\n"),
    };
    let updated = existing + &exchange_text(&timestamp(), user_message, assistant_message);
    let encrypted = state.file_crypto().encrypt_string(&updated);
    blocking(&fp, move |p| std::fs::write(p, encrypted)).await
}

/// `deleteMemory(conversationId)`: best-effort unlink.
pub async fn delete_memory(state: &AppState, conversation_id: &str) {
    let fp = file_path(&state.config().data_dir, conversation_id);
    let _ = blocking(&fp, |p| std::fs::remove_file(p)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_follow_node_join() {
        let d = Path::new("/data");
        assert_eq!(
            file_path(d, "abc"),
            PathBuf::from("/data/chat-memories/abc.md")
        );
        assert_eq!(
            file_path(d, "/etc/x"),
            PathBuf::from("/data/chat-memories/etc/x.md")
        );
        assert_eq!(file_path(d, "../../x"), PathBuf::from("/x.md"));
    }

    #[test]
    fn exchange_format() {
        assert_eq!(
            exchange_text("2026-11-24 10:00:00", "  hi \n", "\tthere "),
            "---\n**[2026-11-24 10:00:00] User:** hi\n\n**Assistant:** there\n"
        );
        let t = timestamp();
        assert_eq!(t.len(), 19);
        assert_eq!(&t[10..11], " ");
    }
}
