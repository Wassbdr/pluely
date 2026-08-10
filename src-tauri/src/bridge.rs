//! Lifecycle for the local Claude Code bridge.
//!
//! The bridge is a small Node server (`resources/claude-bridge/server.mjs`) that
//! exposes Claude Code behind an OpenAI-compatible endpoint. Pluely talks to it
//! as an ordinary custom provider, so this module only has to start it on launch
//! and make sure it does not outlive the app.

use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Port the bridge listens on. Must match the URL of the Pluely provider.
pub const BRIDGE_PORT: u16 = 8787;

const SCRIPT_RESOURCE: &str = "resources/claude-bridge/server.mjs";

#[derive(Default)]
pub struct BridgeState {
    child: Mutex<Option<CommandChild>>,
}

/// True when something already answers on the bridge port.
///
/// Covers both a bridge left running from a previous session and a developer
/// running `node server.mjs` by hand — in either case spawning a second one
/// would just lose the port race.
fn port_in_use() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], BRIDGE_PORT).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Renders a path in the plain form Node understands.
///
/// Tauri resolves Windows resources to verbatim paths (`\\?\C:\...`). Node
/// cannot use one as a script path: it parses the prefix away, is left with
/// `C:`, and exits with `EISDIR: illegal operation on a directory`.
fn plain_path(path: &Path) -> String {
    let rendered = path.to_string_lossy().to_string();
    match rendered.strip_prefix(r"\\?\") {
        Some(stripped) => stripped.to_string(),
        None => rendered,
    }
}

/// Starts the bridge if it is not already running.
///
/// Never fails the app: Pluely stays fully usable with a conventional API
/// provider when Node or the bundled script is missing.
pub fn start(app: &AppHandle) {
    if port_in_use() {
        println!("[bridge] port {BRIDGE_PORT} already serving, reusing it");
        return;
    }

    let script = match app.path().resolve(SCRIPT_RESOURCE, tauri::path::BaseDirectory::Resource) {
        Ok(path) => path,
        Err(e) => {
            eprintln!("[bridge] could not resolve {SCRIPT_RESOURCE}: {e}");
            return;
        }
    };

    if !script.exists() {
        eprintln!("[bridge] script not found at {}", script.display());
        return;
    }

    let spawned = app
        .shell()
        .command("node")
        .args([plain_path(&script)])
        .env("PLUELY_BRIDGE_PORT", BRIDGE_PORT.to_string())
        .env("PLUELY_BRIDGE_EXIT_ON_STDIN_CLOSE", "1")
        .spawn();

    match spawned {
        Ok((mut rx, child)) => {
            println!("[bridge] started (pid {})", child.pid());
            if let Ok(mut guard) = app.state::<BridgeState>().child.lock() {
                *guard = Some(child);
            }

            // The receiver must be drained or the plugin's reader task fills up
            // and stalls; forwarding it to stdout also makes bridge failures
            // visible in Pluely's own logs.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            print!("{}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprint!("[bridge] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[bridge] exited with {:?}", payload.code);
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => {
            eprintln!(
                "[bridge] failed to start (is Node.js on PATH?): {e}\n\
                 [bridge] Pluely will keep working with a regular API provider."
            );
        }
    }
}

/// Kills the bridge. Called on app exit so no orphan `node` process is left
/// behind — Windows does not reap children when the parent dies.
pub fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<BridgeState>() else {
        return;
    };
    let child = match state.child.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    };
    if let Some(child) = child {
        if let Err(e) = child.kill() {
            eprintln!("[bridge] failed to kill: {e}");
        } else {
            println!("[bridge] stopped");
        }
    }
}
