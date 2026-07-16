use serde::Deserialize;
use std::{
    env,
    error::Error,
    fmt, fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    Manager, Url, WebviewUrl, WebviewWindowBuilder,
};

const CONTRACT_JSON: &str = include_str!("../../bootstrap-contract.json");
const CLI_PATH_ENV: &str = "VOCATION_OS_CLI_PATH";
const NODE_PATH_ENV: &str = "VOCATION_OS_NODE_PATH";
const SECURE_SCHEME: &str = "http";
const SECURE_HOST: &str = "127.0.0.1";
const SCRUB_LAUNCH_URL: &str = "window.history.replaceState(null, '', '/today');";

#[derive(Debug)]
enum BootstrapError {
    Contract,
    Launcher,
    Spawn,
    Output,
    Timeout,
    Envelope,
    Target,
    ProcessExited,
    Window,
}

impl fmt::Display for BootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Contract => "VocationOS bootstrap contract is invalid",
            Self::Launcher => "VocationOS command launcher is unavailable",
            Self::Spawn => "VocationOS bootstrap process could not start",
            Self::Output => "VocationOS bootstrap handoff failed",
            Self::Timeout => "VocationOS bootstrap timed out",
            Self::Envelope => "VocationOS bootstrap response was invalid",
            Self::Target => "VocationOS bootstrap target was rejected",
            Self::ProcessExited => "VocationOS bootstrap process exited unexpectedly",
            Self::Window => "VocationOS secure window could not start",
        };
        formatter.write_str(message)
    }
}

impl Error for BootstrapError {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootstrapContract {
    schema_version: u8,
    status: String,
    authority: String,
    network: String,
    scheme: String,
    host: String,
    launch_path_prefix: String,
    launch_token_bytes: usize,
    max_envelope_bytes: usize,
    timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BootstrapEnvelope {
    status: String,
    url: String,
    authority: String,
    network: String,
}

#[derive(Debug)]
struct BootstrapTarget {
    url: Url,
    origin: String,
}

enum Launcher {
    Executable(PathBuf),
    Node {
        executable: PathBuf,
        script: PathBuf,
    },
}

struct BootstrapProcess(Mutex<Option<Child>>);

impl BootstrapProcess {
    fn new(child: Child) -> Self {
        Self(Mutex::new(Some(child)))
    }

    fn stop(&self) {
        let mut child = match self.0.lock() {
            Ok(value) => value,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(mut child) = child.take() {
            terminate(&mut child);
        }
    }

    fn is_running(&self) -> bool {
        let mut child = match self.0.lock() {
            Ok(value) => value,
            Err(poisoned) => poisoned.into_inner(),
        };
        match child.as_mut().map(Child::try_wait) {
            Some(Ok(None)) => true,
            _ => {
                if let Some(mut child) = child.take() {
                    terminate(&mut child);
                }
                false
            }
        }
    }
}

impl Drop for BootstrapProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn contract() -> Result<BootstrapContract, BootstrapError> {
    let value: BootstrapContract =
        serde_json::from_str(CONTRACT_JSON).map_err(|_| BootstrapError::Contract)?;
    if value.schema_version != 1
        || value.scheme != SECURE_SCHEME
        || value.host != SECURE_HOST
        || value.launch_path_prefix != "/launch/"
        || value.launch_token_bytes != 32
        || !(512..=16_384).contains(&value.max_envelope_bytes)
        || !(1_000..=60_000).contains(&value.timeout_ms)
    {
        return Err(BootstrapError::Contract);
    }
    Ok(value)
}

fn canonical_file(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = fs::canonicalize(path).ok()?;
    fs::metadata(&canonical)
        .ok()?
        .is_file()
        .then_some(canonical)
}

#[cfg(debug_assertions)]
fn find_program(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path).find_map(|directory| {
        if !directory.is_absolute() {
            return None;
        }
        #[cfg(windows)]
        let candidate = directory.join(format!("{name}.exe"));
        #[cfg(not(windows))]
        let candidate = directory.join(name);
        canonical_file(&candidate)
    })
}

fn node_executable() -> Result<PathBuf, BootstrapError> {
    if let Some(value) = env::var_os(NODE_PATH_ENV) {
        return canonical_file(&PathBuf::from(value)).ok_or(BootstrapError::Launcher);
    }
    #[cfg(debug_assertions)]
    {
        return find_program("node").ok_or(BootstrapError::Launcher);
    }
    #[cfg(not(debug_assertions))]
    {
        Err(BootstrapError::Launcher)
    }
}

fn is_javascript(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "js" | "mjs" | "cjs"))
        .unwrap_or(false)
}

fn is_shell_script(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "cmd" | "bat" | "ps1"))
        .unwrap_or(false)
}

fn launcher_for_path(path: PathBuf) -> Result<Launcher, BootstrapError> {
    if is_shell_script(&path) {
        return Err(BootstrapError::Launcher);
    }
    if is_javascript(&path) {
        return Ok(Launcher::Node {
            executable: node_executable()?,
            script: path,
        });
    }
    Ok(Launcher::Executable(path))
}

fn adjacent_cli() -> Option<PathBuf> {
    let directory = env::current_exe().ok()?.parent()?.to_path_buf();
    #[cfg(windows)]
    let names = ["vocation-cli.exe", "vocation.exe"];
    #[cfg(not(windows))]
    let names = ["vocation-cli", "vocation"];
    names
        .iter()
        .find_map(|name| canonical_file(&directory.join(name)))
}

#[cfg(debug_assertions)]
fn debug_cli_script() -> Option<PathBuf> {
    canonical_file(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../dist/cli.js"))
}

fn resolve_launcher() -> Result<Launcher, BootstrapError> {
    if let Some(value) = env::var_os(CLI_PATH_ENV) {
        let path = canonical_file(&PathBuf::from(value)).ok_or(BootstrapError::Launcher)?;
        return launcher_for_path(path);
    }
    if let Some(path) = adjacent_cli() {
        return launcher_for_path(path);
    }
    #[cfg(debug_assertions)]
    if let Some(path) = debug_cli_script() {
        return launcher_for_path(path);
    }
    Err(BootstrapError::Launcher)
}

fn bootstrap_command(launcher: Launcher) -> Command {
    let mut command = match launcher {
        Launcher::Executable(path) => Command::new(path),
        Launcher::Node { executable, script } => {
            let mut command = Command::new(executable);
            command.arg(script);
            command
        }
    };
    command
        .args(["workbench", "--no-open"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("NO_COLOR", "1");
    command
}

fn read_envelope<R: Read>(mut input: R, limit: usize) -> Result<Vec<u8>, BootstrapError> {
    let mut buffer = Vec::with_capacity(limit.min(4_096));
    let mut chunk = [0_u8; 256];
    loop {
        let remaining = limit.saturating_sub(buffer.len());
        if remaining == 0 {
            return Err(BootstrapError::Output);
        }
        let read_length = remaining.min(chunk.len());
        let count = input
            .read(&mut chunk[..read_length])
            .map_err(|_| BootstrapError::Output)?;
        if count == 0 {
            return Err(BootstrapError::Output);
        }
        for byte in &chunk[..count] {
            buffer.push(*byte);
            if *byte != b'\n' && *byte != b'}' {
                continue;
            }
            match serde_json::from_slice::<serde_json::Value>(&buffer) {
                Ok(_) => return Ok(buffer),
                Err(error) if error.is_eof() => {}
                Err(_) => return Err(BootstrapError::Envelope),
            }
        }
    }
}

fn token_length(bytes: usize) -> usize {
    (bytes * 8 + 5) / 6
}

fn validate_target(
    bytes: &[u8],
    contract: &BootstrapContract,
) -> Result<BootstrapTarget, BootstrapError> {
    if bytes.len() > contract.max_envelope_bytes {
        return Err(BootstrapError::Envelope);
    }
    let envelope: BootstrapEnvelope =
        serde_json::from_slice(bytes).map_err(|_| BootstrapError::Envelope)?;
    if envelope.status != contract.status
        || envelope.authority != contract.authority
        || envelope.network != contract.network
        || envelope.url.trim() != envelope.url
        || envelope.url.chars().any(char::is_control)
    {
        return Err(BootstrapError::Envelope);
    }
    let url = Url::parse(&envelope.url).map_err(|_| BootstrapError::Target)?;
    let token = url
        .path()
        .strip_prefix(&contract.launch_path_prefix)
        .ok_or(BootstrapError::Target)?;
    if url.scheme() != SECURE_SCHEME
        || url.host_str() != Some(SECURE_HOST)
        || !matches!(url.port(), Some(port) if port > 0)
        || url.as_str() != envelope.url
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || token.len() != token_length(contract.launch_token_bytes)
        || !token
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-' || value == b'_')
    {
        return Err(BootstrapError::Target);
    }
    Ok(BootstrapTarget {
        origin: url.origin().ascii_serialization(),
        url,
    })
}

fn terminate(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn launch_bootstrap() -> Result<(Child, BootstrapTarget, Duration), BootstrapError> {
    let contract = contract()?;
    let mut child = bootstrap_command(resolve_launcher()?)
        .spawn()
        .map_err(|_| BootstrapError::Spawn)?;
    let stdout = match child.stdout.take() {
        Some(value) => value,
        None => {
            terminate(&mut child);
            return Err(BootstrapError::Output);
        }
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    let limit = contract.max_envelope_bytes;
    let _reader_thread = thread::spawn(move || {
        let _ = sender.send(read_envelope(stdout, limit));
    });
    let timeout = Duration::from_millis(contract.timeout_ms);
    let bytes = match receiver.recv_timeout(timeout) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            terminate(&mut child);
            return Err(error);
        }
        Err(RecvTimeoutError::Timeout) => {
            terminate(&mut child);
            return Err(BootstrapError::Timeout);
        }
        Err(RecvTimeoutError::Disconnected) => {
            terminate(&mut child);
            return Err(BootstrapError::Output);
        }
    };
    let target = match validate_target(&bytes, &contract) {
        Ok(value) => value,
        Err(error) => {
            terminate(&mut child);
            return Err(error);
        }
    };
    match child.try_wait() {
        Ok(None) => {}
        Ok(Some(_)) | Err(_) => {
            terminate(&mut child);
            return Err(BootstrapError::ProcessExited);
        }
    }
    Ok((child, target, timeout))
}

fn exact_origin(url: &Url, expected: &str) -> bool {
    url.scheme() == SECURE_SCHEME
        && url.host_str() == Some(SECURE_HOST)
        && matches!(url.port(), Some(port) if port > 0)
        && url.username().is_empty()
        && url.password().is_none()
        && url.origin().ascii_serialization() == expected
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let (child, target, timeout) = launch_bootstrap()?;
            if !app.manage(BootstrapProcess::new(child)) {
                return Err(BootstrapError::Window.into());
            }

            let expected_origin = target.origin.clone();
            let load_origin = target.origin.clone();
            let expected_launch = target.url.clone();
            let ready = Arc::new(AtomicBool::new(false));
            let load_ready = Arc::clone(&ready);

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(target.url))
                .title("VocationOS")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 680.0)
                .center()
                .visible(false)
                .incognito(true)
                .devtools(cfg!(debug_assertions))
                .on_navigation(move |url| exact_origin(url, &expected_origin))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .on_page_load(move |window, payload| {
                    if !matches!(payload.event(), PageLoadEvent::Finished)
                        || load_ready.load(Ordering::Acquire)
                    {
                        return;
                    }
                    let accepted = payload.url() == &expected_launch
                        && exact_origin(payload.url(), &load_origin)
                        && window.eval(SCRUB_LAUNCH_URL).is_ok()
                        && window.show().is_ok();
                    if accepted {
                        load_ready.store(true, Ordering::Release);
                    } else {
                        let _ = window.close();
                        window.app_handle().exit(1);
                    }
                })
                .build()
                .map_err(|_| BootstrapError::Window)?;

            let handle = app.handle().clone();
            let _monitor_thread = thread::spawn(move || {
                let deadline = Instant::now() + timeout;
                loop {
                    thread::sleep(Duration::from_millis(250));
                    let process_running = handle.state::<BootstrapProcess>().is_running();
                    let load_timed_out =
                        !ready.load(Ordering::Acquire) && Instant::now() >= deadline;
                    if !process_running || load_timed_out {
                        handle.exit(1);
                        break;
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("VocationOS desktop runtime failed");
    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            app_handle.state::<BootstrapProcess>().stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn envelope(url: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "status": "running",
            "url": url,
            "authority": "vocationd",
            "network": "127.0.0.1-only"
        }))
        .expect("test envelope must serialize")
    }

    fn valid_url() -> String {
        format!("http://127.0.0.1:43117/launch/{}", "A".repeat(43))
    }

    #[test]
    fn accepts_the_exact_loopback_launch_contract() {
        let contract = contract().expect("embedded contract must be valid");
        let target = validate_target(&envelope(&valid_url()), &contract)
            .expect("valid target must be accepted");
        assert_eq!(target.origin, "http://127.0.0.1:43117");
    }

    #[test]
    fn rejects_non_loopback_or_ambiguous_launch_targets() {
        let contract = contract().expect("embedded contract must be valid");
        for url in [
            format!("https://127.0.0.1:43117/launch/{}", "A".repeat(43)),
            format!("http://localhost:43117/launch/{}", "A".repeat(43)),
            format!("http://127.0.0.1/launch/{}", "A".repeat(43)),
            format!("http://127.0.0.1:0/launch/{}", "A".repeat(43)),
            format!("http://2130706433:43117/launch/{}", "A".repeat(43)),
            format!("http://user@127.0.0.1:43117/launch/{}", "A".repeat(43)),
            format!("http://127.0.0.1:43117/launch/{}?x=1", "A".repeat(43)),
            "http://127.0.0.1:43117/launch/short".to_string(),
        ] {
            assert!(validate_target(&envelope(&url), &contract).is_err());
        }
    }

    #[test]
    fn rejects_envelope_contract_drift() {
        let contract = contract().expect("embedded contract must be valid");
        let value = serde_json::json!({
            "status": "running",
            "url": valid_url(),
            "authority": "other",
            "network": "127.0.0.1-only",
            "extra": true
        });
        assert!(validate_target(&serde_json::to_vec(&value).unwrap(), &contract).is_err());
    }

    #[test]
    fn navigation_requires_the_exact_bootstrap_origin() {
        let origin = "http://127.0.0.1:43117";
        assert!(exact_origin(
            &Url::parse("http://127.0.0.1:43117/today").unwrap(),
            origin
        ));
        assert!(!exact_origin(
            &Url::parse("http://127.0.0.1:43118/today").unwrap(),
            origin
        ));
        assert!(!exact_origin(
            &Url::parse("http://localhost:43117/today").unwrap(),
            origin
        ));
    }

    #[test]
    fn stdout_reader_is_bounded_without_newlines() {
        let oversized = vec![b'x'; 513];
        assert!(read_envelope(Cursor::new(oversized), 512).is_err());
        let valid = envelope(&valid_url());
        assert_eq!(read_envelope(Cursor::new(&valid), 512).unwrap(), valid);
    }
}
