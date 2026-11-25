//! Backend logs (startup jobs, request log, errors) go to stderr and to
//! `server.log` in the app data folder, as the sidecar's output did. The file
//! is truncated at each launch. Passcodes and keys are never logged.

use std::fs::File;
use std::path::Path;
use std::sync::Mutex;

use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::EnvFilter;

pub fn init(log_path: &Path) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_ansi(false);
    let result = match File::create(log_path) {
        Ok(file) => builder
            .with_writer(std::io::stderr.and(Mutex::new(file)))
            .try_init(),
        Err(err) => {
            eprintln!("could not create {}: {err}", log_path.display());
            builder.with_writer(std::io::stderr).try_init()
        }
    };
    if let Err(err) = result {
        eprintln!("could not set up logging: {err}");
    }
}
