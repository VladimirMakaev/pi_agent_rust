use chrono::Utc;
use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;
use url::Url;

use super::{AgentState, Cmd, PiApp, PiMsg};

#[cfg(feature = "clipboard")]
use clipboard::{ClipboardContext, ClipboardProvider};

pub(super) fn run_command_output(
    program: &str,
    args: &[OsString],
    cwd: &Path,
    abort_signal: &crate::agent::AbortSignal,
) -> std::io::Result<std::process::Output> {
    use std::process::{Command, Stdio};
    use std::sync::mpsc as std_mpsc;
    use std::time::Duration;

    let child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pid = child.id();

    let (tx, rx) = std_mpsc::channel();
    std::thread::spawn(move || {
        let result = child.wait_with_output();
        let _ = tx.send(result);
    });

    let tick = Duration::from_millis(10);
    loop {
        if abort_signal.is_aborted() {
            crate::tools::kill_process_tree(Some(pid));
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "command aborted",
            ));
        }

        match rx.recv_timeout(tick) {
            Ok(result) => return result,
            Err(std_mpsc::RecvTimeoutError::Timeout) => {}
            Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                return Err(std::io::Error::other("command output channel disconnected"));
            }
        }
    }
}

pub(super) fn parse_gist_url_and_id(output: &str) -> Option<(String, String)> {
    for raw in output.split_whitespace() {
        let candidate_url = raw.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';'));
        let Ok(url) = Url::parse(candidate_url) else {
            continue;
        };
        let Some(host) = url.host_str() else {
            continue;
        };
        if host != "gist.github.com" {
            continue;
        }
        let Some(gist_id) = url.path_segments().and_then(|mut seg| seg.next_back()) else {
            continue;
        };
        if gist_id.is_empty() {
            continue;
        }
        return Some((candidate_url.to_string(), gist_id.to_string()));
    }
    None
}

pub(super) fn format_command_output(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => "(no output)".to_string(),
        (false, true) => format!("stdout:\n{stdout}"),
        (true, false) => format!("stderr:\n{stderr}"),
        (false, false) => format!("stdout:\n{stdout}\n\nstderr:\n{stderr}"),
    }
}

/// Build a gist description from the optional session name and current time.
pub(super) fn share_gist_description(session_name: Option<&str>) -> String {
    session_name.map_or_else(
        || format!("Pi session {}", Utc::now().format("%Y-%m-%dT%H:%M:%SZ")),
        |name| format!("Pi session: {name}"),
    )
}

/// Check whether `/share` args request a public gist.
pub(super) fn parse_share_is_public(args: &str) -> bool {
    args.split_whitespace()
        .any(|w| w.eq_ignore_ascii_case("public"))
}

impl PiApp {
    #[allow(clippy::too_many_lines)]
    pub(super) fn handle_slash_share(&mut self, args: &str) -> Option<Cmd> {
        if self.agent_state != AgentState::Idle {
            self.status_message = Some("Cannot share while processing".to_string());
            return None;
        }

        let is_public = parse_share_is_public(args);

        self.agent_state = AgentState::Processing;
        self.status_message = Some("Sharing session... (Esc to cancel)".to_string());

        let (abort_handle, abort_signal) = crate::agent::AbortHandle::new();
        self.abort_handle = Some(abort_handle);

        let event_tx = self.event_tx.clone();
        let runtime_handle = self.runtime_handle.clone();
        let session = Arc::clone(&self.session);
        let cwd = self.cwd.clone();
        let gh_path_override = self.config.gh_path.clone();

        runtime_handle.spawn(async move {
            let gh = gh_path_override
                .as_ref()
                .filter(|value| !value.trim().is_empty())
                .cloned()
                .unwrap_or_else(|| "gh".to_string());

            let auth_args = vec![OsString::from("auth"), OsString::from("status")];
            match run_command_output(&gh, &auth_args, &cwd, &abort_signal) {
                Ok(output) => {
                    if !output.status.success() {
                        let details = format_command_output(&output);
                        let message = format!(
                            "`gh` is not authenticated.\n\
                             Run `gh auth login` to authenticate, then retry `/share`.\n\n\
                             {details}"
                        );
                        let _ = event_tx.try_send(PiMsg::AgentError(message));
                        return;
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    let message = "GitHub CLI `gh` not found.\n\
                             Install it from https://cli.github.com, then run `gh auth login`."
                        .to_string();
                    let _ = event_tx.try_send(PiMsg::AgentError(message));
                    return;
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {
                    let _ = event_tx.try_send(PiMsg::System("Share cancelled".to_string()));
                    return;
                }
                Err(err) => {
                    let _ = event_tx.try_send(PiMsg::AgentError(format!(
                        "Failed to run `gh auth status`: {err}"
                    )));
                    return;
                }
            }

            if abort_signal.is_aborted() {
                let _ = event_tx.try_send(PiMsg::System("Share cancelled".to_string()));
                return;
            }

            let cx = asupersync::Cx::for_request();
            let (html, session_name) = match session.lock(&cx).await {
                Ok(guard) => (guard.to_html(), guard.get_name()),
                Err(err) => {
                    let _ = event_tx
                        .try_send(PiMsg::AgentError(format!("Failed to lock session: {err}")));
                    return;
                }
            };

            if abort_signal.is_aborted() {
                let _ = event_tx.try_send(PiMsg::System("Share cancelled".to_string()));
                return;
            }

            let gist_desc = share_gist_description(session_name.as_deref());

            let temp_file = match tempfile::Builder::new()
                .prefix("pi-share-")
                .suffix(".html")
                .tempfile()
            {
                Ok(file) => file,
                Err(err) => {
                    let _ = event_tx.try_send(PiMsg::AgentError(format!(
                        "Failed to create temp file: {err}"
                    )));
                    return;
                }
            };
            let temp_path = temp_file.into_temp_path();
            if let Err(err) = std::fs::write(&temp_path, html.as_bytes()) {
                let _ = event_tx.try_send(PiMsg::AgentError(format!(
                    "Failed to write temp file: {err}"
                )));
                return;
            }

            let gist_args = vec![
                OsString::from("gist"),
                OsString::from("create"),
                OsString::from(format!("--public={is_public}")),
                OsString::from("--desc"),
                OsString::from(&gist_desc),
                temp_path.as_os_str().to_os_string(),
            ];
            let output = match run_command_output(&gh, &gist_args, &cwd, &abort_signal) {
                Ok(output) => output,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    let message = "GitHub CLI `gh` not found.\n\
                             Install it from https://cli.github.com, then run `gh auth login`."
                        .to_string();
                    let _ = event_tx.try_send(PiMsg::AgentError(message));
                    return;
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {
                    let _ = event_tx.try_send(PiMsg::System("Share cancelled".to_string()));
                    return;
                }
                Err(err) => {
                    let _ = event_tx.try_send(PiMsg::AgentError(format!(
                        "Failed to run `gh gist create`: {err}"
                    )));
                    return;
                }
            };

            if !output.status.success() {
                let details = format_command_output(&output);
                let _ = event_tx.try_send(PiMsg::AgentError(format!(
                    "`gh gist create` failed.\n\n{details}"
                )));
                return;
            }

            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let Some((gist_url, gist_id)) = parse_gist_url_and_id(&stdout) else {
                let details = format_command_output(&output);
                let _ = event_tx.try_send(PiMsg::AgentError(format!(
                    "Failed to parse gist URL from `gh gist create` output.\n\n{details}"
                )));
                return;
            };

            let share_url = crate::session::get_share_viewer_url(&gist_id);
            drop(temp_path);

            // Copy viewer URL to clipboard (best-effort).
            #[cfg(feature = "clipboard")]
            {
                let _ = ClipboardProvider::new()
                    .and_then(|mut ctx: ClipboardContext| ctx.set_contents(share_url.clone()));
            }

            let privacy = if is_public { "public" } else { "private" };
            let message =
                format!("Created {privacy} gist\nShare URL: {share_url}\nGist: {gist_url}");
            let _ = event_tx.try_send(PiMsg::System(message));
        });
        None
    }
}
