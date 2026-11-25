//! Unlock / wrong passcode / shutdown / wipe lifecycle of the in-process
//! backend, against a temp data dir. Ports are picked by the OS (never 3001),
//! so a running openFinance is not disturbed.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use openfinance_core::Config;
use openfinance_desktop_lib::backend::{self, Backend, Shutdown, StartError};

const PASSCODE: &str = "correct horse battery";

fn db_path(dir: &Path) -> PathBuf {
    dir.join("openfinance.db")
}

fn config(dir: &Path, passcode: &str) -> Config {
    let mut config = backend::desktop_config(&db_path(dir), passcode.to_string());
    config.no_network = true;
    config.ollama_url_env = Some("http://127.0.0.1:9".into());
    config
}

fn any_port() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 0))
}

struct Reply {
    status: u16,
    head: String,
    body: String,
}

/// One HTTP/1.1 request on a fresh connection (`Connection: close`).
fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> Reply {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("timeout");
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    stream.write_all(req.as_bytes()).expect("write");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("read");
    let (head, body) = raw.split_once("\r\n\r\n").expect("head/body");
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status");
    Reply {
        status,
        head: head.to_ascii_lowercase(),
        body: body.to_string(),
    }
}

fn get(addr: SocketAddr, path: &str) -> Reply {
    request(addr, "GET", path, &[], "")
}

fn refused(addr: SocketAddr) -> bool {
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_err()
}

fn sidecar(dir: &Path, suffix: &str) -> PathBuf {
    let mut p = db_path(dir).into_os_string();
    p.push(suffix);
    PathBuf::from(p)
}

#[test]
fn unlock_serves_the_api_and_shutdown_releases_everything() {
    let dir = tempfile::tempdir().expect("tmp");
    let backend = Backend::start(config(dir.path(), PASSCODE), any_port()).expect("start");
    let addr = backend.addr();
    assert_ne!(addr.port(), backend::DEFAULT_PORT);

    let health = get(addr, "/health");
    assert_eq!(
        (health.status, health.body.as_str()),
        (200, r#"{"status":"ok"}"#)
    );

    // Same origin guard and CORS as the sidecar.
    let ok = request(
        addr,
        "GET",
        "/health",
        &[("Origin", "tauri://localhost")],
        "",
    );
    assert_eq!(ok.status, 200);
    assert!(ok
        .head
        .contains("access-control-allow-origin: tauri://localhost"));
    let evil = request(
        addr,
        "GET",
        "/health",
        &[("Origin", "https://evil.example")],
        "",
    );
    assert_eq!(
        (evil.status, evil.body.as_str()),
        (403, r#"{"error":"Forbidden origin"}"#)
    );

    // A write, so the WAL has something in it.
    let created = request(
        addr,
        "POST",
        "/api/budget/accounts",
        &[("Content-Type", "application/json")],
        r#"{"name":"Lifecycle","type":"checking"}"#,
    );
    assert_eq!(created.status, 201, "{}", created.body);
    assert!(sidecar(dir.path(), "-wal").exists());

    // An idle keep-alive connection (like the webview's) must not hold up shutdown.
    let mut idle = TcpStream::connect(addr).expect("connect");
    idle.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        .expect("write");
    let mut buf = [0u8; 256];
    let _ = idle.read(&mut buf).expect("read");

    let started = Instant::now();
    assert_eq!(backend.shutdown(), Shutdown::Graceful);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );

    assert!(refused(addr), "port still accepting after shutdown");
    // Closing the last connection checkpoints the WAL and removes it.
    assert!(
        !sidecar(dir.path(), "-wal").exists(),
        "database not closed cleanly"
    );
    assert!(
        !sidecar(dir.path(), "-shm").exists(),
        "database not closed cleanly"
    );

    // The same port can be bound again straight away (a re-unlock).
    let again = Backend::start(config(dir.path(), PASSCODE), addr).expect("restart");
    assert_eq!(again.addr(), addr);
    let accounts = get(addr, "/api/budget/accounts");
    assert_eq!(accounts.status, 200);
    assert!(accounts.body.contains("Lifecycle"), "{}", accounts.body);
    drop(again); // Drop shuts down too.
    assert!(refused(addr));
}

#[test]
fn wrong_passcode_fails_cleanly_and_the_right_one_then_unlocks() {
    let dir = tempfile::tempdir().expect("tmp");
    let first = Backend::start(config(dir.path(), PASSCODE), any_port()).expect("create");
    let addr = first.addr();
    assert_eq!(first.shutdown(), Shutdown::Graceful);

    for _ in 0..2 {
        let err = Backend::start(config(dir.path(), "not the passcode"), addr)
            .err()
            .expect("wrong passcode must fail");
        assert!(matches!(err, StartError::WrongPasscode), "{err}");
        assert!(refused(addr), "a failed unlock left a listener");
        assert!(
            !sidecar(dir.path(), "-wal").exists(),
            "a failed unlock left the db open"
        );
    }

    let unlocked = Backend::start(config(dir.path(), PASSCODE), addr).expect("unlock");
    assert_eq!(get(addr, "/health").status, 200);
    assert_eq!(unlocked.shutdown(), Shutdown::Graceful);
}

#[test]
fn port_in_use_fails_without_leaving_the_database_open() {
    let dir = tempfile::tempdir().expect("tmp");
    let squatter = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = squatter.local_addr().expect("addr");

    let err = Backend::start(config(dir.path(), PASSCODE), addr)
        .err()
        .expect("port in use must fail");
    assert!(matches!(err, StartError::Listen { .. }), "{err}");
    assert!(db_path(dir.path()).exists());
    assert!(!sidecar(dir.path(), "-wal").exists());
    drop(squatter);

    let ok = Backend::start(config(dir.path(), PASSCODE), addr).expect("start");
    assert_eq!(get(addr, "/health").status, 200);
    assert_eq!(ok.shutdown(), Shutdown::Graceful);
}

#[test]
fn wipe_removes_the_database_uploads_and_memories() {
    let dir = tempfile::tempdir().expect("tmp");
    let running = Backend::start(config(dir.path(), PASSCODE), any_port()).expect("start");
    let addr = running.addr();
    assert_eq!(get(addr, "/health").status, 200);

    let uploads = dir.path().join("uploads/documents");
    let memories = dir.path().join("chat-memories");
    std::fs::create_dir_all(&uploads).expect("uploads");
    std::fs::create_dir_all(&memories).expect("memories");
    std::fs::write(uploads.join("doc_x.pdf"), b"x").expect("doc");
    std::fs::write(memories.join("c1.md"), b"x").expect("memory");
    std::fs::write(sidecar(dir.path(), "-journal"), b"").expect("journal");
    std::fs::write(dir.path().join("server.log"), b"log").expect("log");

    assert_eq!(running.shutdown(), Shutdown::Graceful);
    backend::wipe_files(&db_path(dir.path()));

    for gone in [
        db_path(dir.path()),
        sidecar(dir.path(), "-wal"),
        sidecar(dir.path(), "-shm"),
        sidecar(dir.path(), "-journal"),
        dir.path().join("uploads"),
        dir.path().join("chat-memories"),
    ] {
        assert!(!gone.exists(), "{} survived the wipe", gone.display());
    }
    // Only those: other files in the folder stay.
    assert!(dir.path().join("server.log").exists());
    assert!(refused(addr));

    // A fresh database can be created afterwards with a new passcode.
    let fresh = Backend::start(config(dir.path(), "a new passcode"), addr).expect("fresh");
    assert_eq!(get(addr, "/health").status, 200);
    assert_eq!(fresh.shutdown(), Shutdown::Graceful);
}

#[test]
fn a_stuck_request_is_aborted_and_the_database_still_closes() {
    let dir = tempfile::tempdir().expect("tmp");
    let running = Backend::start(config(dir.path(), PASSCODE), any_port()).expect("start");
    let addr = running.addr();
    assert_eq!(get(addr, "/health").status, 200);

    // A request whose body never finishes arriving stays in flight forever.
    let mut stuck = TcpStream::connect(addr).expect("connect");
    stuck
        .write_all(
            b"POST /api/budget/accounts HTTP/1.1\r\nHost: 127.0.0.1\r\n\
              Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"name\":",
        )
        .expect("write");
    std::thread::sleep(Duration::from_millis(200));

    let started = Instant::now();
    assert_eq!(running.shutdown(), Shutdown::Aborted);
    let took = started.elapsed();
    assert!(
        took >= Duration::from_secs(2),
        "did not wait for the request: {took:?}"
    );
    assert!(took < Duration::from_secs(8), "shutdown hung: {took:?}");
    assert!(refused(addr));
    assert!(
        !sidecar(dir.path(), "-wal").exists(),
        "database not closed cleanly"
    );
}
