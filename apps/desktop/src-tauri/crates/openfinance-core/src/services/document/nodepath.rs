//! The bits of Node's `path` module (POSIX flavour) that the document and
//! backup code relies on. `path.join` normalises lexically (so `..` in a stored
//! file name walks out of the uploads folder, exactly as in Node) and keeps a
//! trailing slash; `std::path::Path::join` would replace the base for an
//! absolute name instead, so it must not be used for these paths.

use std::path::{Path, PathBuf};

/// `path.normalize(p)` (POSIX).
pub fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".to_string();
    }
    let absolute = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let mut out = parts.join("/");
    if out.is_empty() && !absolute {
        out.push('.');
    }
    if !out.is_empty() && trailing {
        out.push('/');
    }
    if absolute {
        format!("/{out}")
    } else {
        out
    }
}

/// `path.join(...parts)` (POSIX): non-empty parts joined with `/`, then normalised.
pub fn join_str(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".to_string();
    }
    normalize(&joined.join("/"))
}

/// `path.join(base, name)` for a directory on disk and a stored file name.
pub fn join(base: &Path, name: &str) -> PathBuf {
    let base = base.to_string_lossy();
    PathBuf::from(join_str(&[&base, name]))
}

/// `path.extname(p)` (POSIX).
pub fn extname(p: &str) -> String {
    let chars: Vec<char> = p.chars().collect();
    let mut start_dot: isize = -1;
    let mut start_part: isize = 0;
    let mut end: isize = -1;
    let mut matched_slash = true;
    // 0: no dot seen yet before the last one; 1: another dot; -1: a non-dot.
    let mut pre_dot_state = 0;
    let mut i = chars.len() as isize - 1;
    while i >= 0 {
        let c = chars[i as usize];
        if c == '/' {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            i -= 1;
            continue;
        }
        if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        if c == '.' {
            if start_dot == -1 {
                start_dot = i;
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot != -1 {
            pre_dot_state = -1;
        }
        i -= 1;
    }
    if start_dot == -1
        || end == -1
        || pre_dot_state == 0
        || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)
    {
        return String::new();
    }
    chars[start_dot as usize..end as usize].iter().collect()
}

/// `path.basename(p)` (POSIX, no suffix argument).
pub fn basename(p: &str) -> String {
    let trimmed = p.trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    match trimmed.rfind('/') {
        Some(i) => trimmed[i + 1..].to_string(),
        None => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values produced by Node's `path` module.
    #[test]
    fn join_like_node() {
        assert_eq!(join_str(&["/a/b", "doc_x.pdf"]), "/a/b/doc_x.pdf");
        assert_eq!(join_str(&["/a/b", ""]), "/a/b");
        assert_eq!(join_str(&["/a/b", "../../c"]), "/c");
        assert_eq!(join_str(&["/a/b", "../../../../c"]), "/c");
        assert_eq!(join_str(&["/a/b", "/etc/x"]), "/a/b/etc/x");
        assert_eq!(join_str(&["/a/b", "x/"]), "/a/b/x/");
        assert_eq!(join_str(&["/a/b", "."]), "/a/b");
        assert_eq!(join_str(&["/a/b", ".."]), "/a");
        assert_eq!(join_str(&["documents", "f.txt"]), "documents/f.txt");
        assert_eq!(join_str(&["a", "../.."]), "..");
        assert_eq!(normalize("./"), "./");
        assert_eq!(normalize("a/.."), ".");
    }

    #[test]
    fn extname_like_node() {
        for (p, e) in [
            ("a.pdf", ".pdf"),
            ("a.tar.gz", ".gz"),
            (".bashrc", ""),
            ("a.", "."),
            ("a", ""),
            ("", ""),
            ("..", ""),
            ("...", "."),
            ("a/b.c/", ".c"),
            ("dir.x/file", ""),
            ("..pdf", ".pdf"),
            ("ünï.cødé", ".cødé"),
        ] {
            assert_eq!(extname(p), e, "extname({p:?})");
        }
    }

    #[test]
    fn basename_like_node() {
        assert_eq!(basename("documents/a.pdf"), "a.pdf");
        assert_eq!(basename("documents/sub/b"), "b");
        assert_eq!(basename("documents/x/"), "x");
        assert_eq!(basename("documents/.."), "..");
        assert_eq!(basename("/"), "");
    }
}
