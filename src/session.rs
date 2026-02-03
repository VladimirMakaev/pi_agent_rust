//! Session management and persistence.
//!
//! Sessions are stored as JSONL files with a tree structure that enables
//! branching and history navigation.

use crate::cli::Cli;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::model::{
    AssistantMessage, ContentBlock, Message, ToolResultMessage, UserContent, UserMessage,
};
use crate::session_index::SessionIndex;
use crate::tui::PiConsole;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Current session file format version.
pub const SESSION_VERSION: u8 = 3;

// ============================================================================
// Session
// ============================================================================

/// A session manages conversation state and persistence.
pub struct Session {
    /// Session header
    pub header: SessionHeader,
    /// Session entries (messages, changes, etc.)
    pub entries: Vec<SessionEntry>,
    /// Path to the session file (None for in-memory)
    pub path: Option<PathBuf>,
    /// Current leaf entry ID
    pub leaf_id: Option<String>,
    /// Base directory for session storage (optional override)
    pub session_dir: Option<PathBuf>,
}

impl Session {
    /// Create a new session from CLI args and config.
    pub async fn new(cli: &Cli, config: &Config) -> Result<Self> {
        let session_dir = cli.session_dir.as_ref().map(PathBuf::from);
        if cli.no_session {
            return Ok(Self::in_memory());
        }

        if let Some(path) = &cli.session {
            return Self::open(path).await;
        }

        if cli.resume {
            return Self::resume_with_picker(session_dir.as_deref(), config).await;
        }

        if cli.r#continue {
            return Self::continue_recent_in_dir(session_dir.as_deref(), config).await;
        }

        // Create a new session
        Ok(Self::create_with_dir(session_dir))
    }

    /// Resume a session by prompting the user to select from recent sessions.
    pub async fn resume_with_picker(override_dir: Option<&Path>, _config: &Config) -> Result<Self> {
        let base_dir = override_dir
            .map(PathBuf::from)
            .unwrap_or_else(Config::sessions_dir);
        let cwd = std::env::current_dir()?;
        let encoded_cwd = encode_cwd(&cwd);
        let project_session_dir = base_dir.join(&encoded_cwd);

        if !project_session_dir.exists() {
            return Ok(Self::create_with_dir(Some(base_dir)));
        }

        let mut entries = if override_dir.is_none() {
            let index = SessionIndex::new();
            match index.list_sessions(Some(&cwd.display().to_string())) {
                Ok(list) => list
                    .into_iter()
                    .filter_map(SessionPickEntry::from_meta)
                    .collect(),
                Err(_) => Vec::new(),
            }
        } else {
            Vec::new()
        };

        if entries.is_empty() {
            entries = scan_sessions_on_disk(&project_session_dir)?;
        }

        if entries.is_empty() {
            return Ok(Self::create_with_dir(Some(base_dir)));
        }

        entries.sort_by_key(|entry| std::cmp::Reverse(entry.last_modified_ms));
        let max_entries = 20usize.min(entries.len());
        let entries = entries.into_iter().take(max_entries).collect::<Vec<_>>();

        let console = PiConsole::new();
        console.render_info("Select a session to resume:");

        let mut rows: Vec<Vec<String>> = Vec::new();
        for (idx, entry) in entries.iter().enumerate() {
            rows.push(vec![
                format!("{}", idx + 1),
                entry.timestamp.clone(),
                entry.message_count.to_string(),
                entry.name.clone().unwrap_or_else(|| entry.id.clone()),
                entry.path.display().to_string(),
            ]);
        }

        let headers = ["#", "Timestamp", "Messages", "Name", "Path"];
        let row_refs: Vec<Vec<&str>> = rows
            .iter()
            .map(|row| row.iter().map(String::as_str).collect())
            .collect();
        console.render_table(&headers, &row_refs);

        let mut attempts = 0;
        loop {
            attempts += 1;
            if attempts > 3 {
                console.render_warning("No selection made. Starting a new session.");
                return Ok(Self::create_with_dir(Some(base_dir)));
            }

            print!(
                "Enter selection (1-{}, blank to start new): ",
                entries.len()
            );
            let _ = std::io::stdout().flush();

            let mut input = String::new();
            std::io::stdin().read_line(&mut input)?;
            let input = input.trim();
            if input.is_empty() {
                console.render_info("Starting a new session.");
                return Ok(Self::create_with_dir(Some(base_dir)));
            }

            match input.parse::<usize>() {
                Ok(index) if index > 0 && index <= entries.len() => {
                    let selected = &entries[index - 1];
                    return Self::open(selected.path.to_string_lossy().as_ref()).await;
                }
                _ => {
                    console.render_warning("Invalid selection. Try again.");
                }
            }
        }
    }

    /// Create an in-memory (ephemeral) session.
    pub fn in_memory() -> Self {
        Self {
            header: SessionHeader::new(),
            entries: Vec::new(),
            path: None,
            leaf_id: None,
            session_dir: None,
        }
    }

    /// Create a new session.
    pub fn create() -> Self {
        Self::create_with_dir(None)
    }

    /// Create a new session with an optional base directory override.
    pub fn create_with_dir(session_dir: Option<PathBuf>) -> Self {
        let header = SessionHeader::new();
        Self {
            header,
            entries: Vec::new(),
            path: None,
            leaf_id: None,
            session_dir,
        }
    }

    /// Open an existing session.
    pub async fn open(path: &str) -> Result<Self> {
        let path = PathBuf::from(path);
        if !path.exists() {
            return Err(crate::Error::SessionNotFound {
                path: path.display().to_string(),
            });
        }

        let content = tokio::fs::read_to_string(&path).await?;
        let mut lines = content.lines();

        // Parse header (first line)
        let header: SessionHeader = lines
            .next()
            .map(serde_json::from_str)
            .transpose()?
            .ok_or_else(|| crate::Error::session("Empty session file"))?;

        // Parse entries
        let mut entries = Vec::new();
        for line in lines {
            if let Ok(entry) = serde_json::from_str::<SessionEntry>(line) {
                entries.push(entry);
            }
        }

        ensure_entry_ids(&mut entries);

        let leaf_id = entries.iter().rev().find_map(|e| e.base_id().cloned());

        Ok(Self {
            header,
            entries,
            path: Some(path),
            leaf_id,
            session_dir: None,
        })
    }

    /// Continue the most recent session.
    pub async fn continue_recent_in_dir(
        override_dir: Option<&Path>,
        _config: &Config,
    ) -> Result<Self> {
        let base_dir = override_dir.map_or_else(Config::sessions_dir, PathBuf::from);
        let cwd = std::env::current_dir()?;
        let encoded_cwd = encode_cwd(&cwd);
        let project_session_dir = base_dir.join(&encoded_cwd);

        if !project_session_dir.exists() {
            return Ok(Self::create());
        }

        // Find the most recent session file
        let mut entries: Vec<_> = std::fs::read_dir(&project_session_dir)?
            .filter_map(std::result::Result::ok)
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "jsonl"))
            .collect();

        entries.sort_by_key(|e| {
            e.metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        });

        if let Some(entry) = entries.pop() {
            Self::open(entry.path().to_string_lossy().as_ref()).await
        } else {
            Ok(Self::create_with_dir(Some(base_dir)))
        }
    }

    /// Save the session to disk.
    pub async fn save(&mut self) -> Result<()> {
        ensure_entry_ids(&mut self.entries);
        if self.path.is_none() {
            // Create a new path
            let base_dir = self
                .session_dir
                .clone()
                .unwrap_or_else(Config::sessions_dir);
            let cwd = std::env::current_dir()?;
            let encoded_cwd = encode_cwd(&cwd);
            let project_session_dir = base_dir.join(&encoded_cwd);

            tokio::fs::create_dir_all(&project_session_dir).await?;

            let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S%.3fZ");
            let filename = format!("{}_{}.jsonl", timestamp, &self.header.id[..8]);
            self.path = Some(project_session_dir.join(filename));
        }

        let path = self.path.as_ref().unwrap();
        let mut content = String::new();

        // Write header
        content.push_str(&serde_json::to_string(&self.header)?);
        content.push('\n');

        // Write entries
        for entry in &self.entries {
            content.push_str(&serde_json::to_string(entry)?);
            content.push('\n');
        }

        tokio::fs::write(path, content).await?;
        Ok(())
    }

    /// Append a session message entry.
    pub fn append_message(&mut self, message: SessionMessage) -> String {
        let id = self.next_entry_id();
        let base = EntryBase::new(self.leaf_id.clone(), id.clone());
        let entry = SessionEntry::Message(MessageEntry { base, message });
        self.leaf_id = Some(id.clone());
        self.entries.push(entry);
        id
    }

    /// Append a message from the model message types.
    pub fn append_model_message(&mut self, message: Message) -> String {
        self.append_message(SessionMessage::from(message))
    }

    pub fn append_model_change(&mut self, provider: String, model_id: String) -> String {
        let id = self.next_entry_id();
        let base = EntryBase::new(self.leaf_id.clone(), id.clone());
        let entry = SessionEntry::ModelChange(ModelChangeEntry {
            base,
            provider,
            model_id,
        });
        self.leaf_id = Some(id.clone());
        self.entries.push(entry);
        id
    }

    pub fn append_thinking_level_change(&mut self, thinking_level: String) -> String {
        let id = self.next_entry_id();
        let base = EntryBase::new(self.leaf_id.clone(), id.clone());
        let entry = SessionEntry::ThinkingLevelChange(ThinkingLevelChangeEntry {
            base,
            thinking_level,
        });
        self.leaf_id = Some(id.clone());
        self.entries.push(entry);
        id
    }

    pub fn append_session_info(&mut self, name: Option<String>) -> String {
        let id = self.next_entry_id();
        let base = EntryBase::new(self.leaf_id.clone(), id.clone());
        let entry = SessionEntry::SessionInfo(SessionInfoEntry { base, name });
        self.leaf_id = Some(id.clone());
        self.entries.push(entry);
        id
    }

    /// Convert session entries to model messages (for provider context).
    pub fn to_messages(&self) -> Vec<Message> {
        let mut messages = Vec::new();
        for entry in &self.entries {
            if let SessionEntry::Message(msg_entry) = entry {
                if let Some(message) = session_message_to_model(&msg_entry.message) {
                    messages.push(message);
                }
            }
        }
        messages
    }

    /// Render the session as a standalone HTML document.
    pub fn to_html(&self) -> String {
        let mut html = String::new();
        html.push_str("<!doctype html><html><head><meta charset=\"utf-8\">");
        html.push_str("<title>Pi Session</title>");
        html.push_str("<style>");
        html.push_str(
            "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:24px;background:#0b0c10;color:#e6e6e6;}
            h1{margin:0 0 8px 0;}
            .meta{color:#9aa0a6;margin-bottom:24px;font-size:14px;}
            .msg{padding:16px 18px;margin:12px 0;border-radius:8px;background:#14161b;}
            .msg.user{border-left:4px solid #4fc3f7;}
            .msg.assistant{border-left:4px solid #81c784;}
            .msg.tool{border-left:4px solid #ffb74d;}
            .msg.system{border-left:4px solid #ef9a9a;}
            .role{font-weight:600;margin-bottom:8px;}
            pre{white-space:pre-wrap;background:#0f1115;padding:12px;border-radius:6px;overflow:auto;}
            .thinking summary{cursor:pointer;}
            img{max-width:100%;height:auto;border-radius:6px;margin-top:8px;}
            .note{color:#9aa0a6;font-size:13px;margin:6px 0;}
            ",
        );
        html.push_str("</style></head><body>");

        let _ = write!(
            html,
            "<h1>Pi Session</h1><div class=\"meta\">Session {} • {} • cwd: {}</div>",
            escape_html(&self.header.id),
            escape_html(&self.header.timestamp),
            escape_html(&self.header.cwd)
        );

        for entry in &self.entries {
            match entry {
                SessionEntry::Message(message) => {
                    html.push_str(&render_session_message(&message.message));
                }
                SessionEntry::ModelChange(change) => {
                    let _ = write!(
                        html,
                        "<div class=\"msg system\"><div class=\"role\">Model</div><div class=\"note\">{} / {}</div></div>",
                        escape_html(&change.provider),
                        escape_html(&change.model_id)
                    );
                }
                SessionEntry::ThinkingLevelChange(change) => {
                    let _ = write!(
                        html,
                        "<div class=\"msg system\"><div class=\"role\">Thinking</div><div class=\"note\">{}</div></div>",
                        escape_html(&change.thinking_level)
                    );
                }
                SessionEntry::Compaction(compaction) => {
                    let _ = write!(
                        html,
                        "<div class=\"msg system\"><div class=\"role\">Compaction</div><pre>{}</pre></div>",
                        escape_html(&compaction.summary)
                    );
                }
                SessionEntry::BranchSummary(summary) => {
                    let _ = write!(
                        html,
                        "<div class=\"msg system\"><div class=\"role\">Branch Summary</div><pre>{}</pre></div>",
                        escape_html(&summary.summary)
                    );
                }
                SessionEntry::SessionInfo(info) => {
                    if let Some(name) = &info.name {
                        let _ = write!(
                            html,
                            "<div class=\"msg system\"><div class=\"role\">Session Name</div><div class=\"note\">{}</div></div>",
                            escape_html(name)
                        );
                    }
                }
                SessionEntry::Custom(custom) => {
                    let _ = write!(
                        html,
                        "<div class=\"msg system\"><div class=\"role\">{}</div></div>",
                        escape_html(&custom.custom_type)
                    );
                }
                SessionEntry::Label(_) => {}
            }
        }

        html.push_str("</body></html>");
        html
    }

    /// Update header model info.
    pub fn set_model_header(
        &mut self,
        provider: Option<String>,
        model_id: Option<String>,
        thinking_level: Option<String>,
    ) {
        if provider.is_some() {
            self.header.provider = provider;
        }
        if model_id.is_some() {
            self.header.model_id = model_id;
        }
        if thinking_level.is_some() {
            self.header.thinking_level = thinking_level;
        }
    }

    pub fn set_branched_from(&mut self, path: Option<String>) {
        self.header.parent_session = path;
    }

    fn next_entry_id(&self) -> String {
        let existing = entry_id_set(&self.entries);
        generate_entry_id(&existing)
    }
}

#[derive(Debug, Clone)]
struct SessionPickEntry {
    path: PathBuf,
    id: String,
    timestamp: String,
    message_count: u64,
    name: Option<String>,
    last_modified_ms: i64,
}

impl SessionPickEntry {
    fn from_meta(meta: crate::session_index::SessionMeta) -> Option<Self> {
        let path = PathBuf::from(meta.path);
        if !path.exists() {
            return None;
        }
        Some(Self {
            path,
            id: meta.id,
            timestamp: meta.timestamp,
            message_count: meta.message_count,
            name: meta.name,
            last_modified_ms: meta.last_modified_ms,
        })
    }
}

fn scan_sessions_on_disk(project_session_dir: &Path) -> Result<Vec<SessionPickEntry>> {
    let mut entries = Vec::new();
    let dir_entries = std::fs::read_dir(project_session_dir)
        .map_err(|e| Error::session(format!("Failed to read sessions: {e}")))?;
    for entry in dir_entries {
        let entry = entry.map_err(|e| Error::session(format!("Read dir entry: {e}")))?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "jsonl") {
            if let Ok(meta) = load_session_meta(&path) {
                entries.push(meta);
            }
        }
    }
    Ok(entries)
}

fn load_session_meta(path: &Path) -> Result<SessionPickEntry> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| Error::session(format!("Failed to read session: {e}")))?;
    let mut lines = content.lines();
    let header_line = lines
        .next()
        .ok_or_else(|| Error::session("Empty session file"))?;
    let header: SessionHeader =
        serde_json::from_str(header_line).map_err(|e| Error::session(format!("{e}")))?;

    let mut message_count = 0u64;
    let mut name = None;
    for line in lines {
        if let Ok(entry) = serde_json::from_str::<SessionEntry>(line) {
            match entry {
                SessionEntry::Message(_) => message_count += 1,
                SessionEntry::SessionInfo(info) => {
                    if info.name.is_some() {
                        name = info.name;
                    }
                }
                _ => {}
            }
        }
    }

    let modified = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let last_modified_ms = modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    Ok(SessionPickEntry {
        path: path.to_path_buf(),
        id: header.id,
        timestamp: header.timestamp,
        message_count,
        name,
        last_modified_ms,
    })
}

// ============================================================================
// Session Header
// ============================================================================

/// Session file header.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHeader {
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u8>,
    pub id: String,
    pub timestamp: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        rename = "branchedFrom",
        alias = "parentSession"
    )]
    pub parent_session: Option<String>,
}

impl SessionHeader {
    pub fn new() -> Self {
        let now = chrono::Utc::now();
        Self {
            r#type: "session".to_string(),
            version: Some(SESSION_VERSION),
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            cwd: std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            provider: None,
            model_id: None,
            thinking_level: None,
            parent_session: None,
        }
    }
}

impl Default for SessionHeader {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Session Entries
// ============================================================================

/// A session entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEntry {
    Message(MessageEntry),
    ModelChange(ModelChangeEntry),
    ThinkingLevelChange(ThinkingLevelChangeEntry),
    Compaction(CompactionEntry),
    BranchSummary(BranchSummaryEntry),
    Label(LabelEntry),
    SessionInfo(SessionInfoEntry),
    Custom(CustomEntry),
}

impl SessionEntry {
    pub const fn base(&self) -> &EntryBase {
        match self {
            Self::Message(e) => &e.base,
            Self::ModelChange(e) => &e.base,
            Self::ThinkingLevelChange(e) => &e.base,
            Self::Compaction(e) => &e.base,
            Self::BranchSummary(e) => &e.base,
            Self::Label(e) => &e.base,
            Self::SessionInfo(e) => &e.base,
            Self::Custom(e) => &e.base,
        }
    }

    pub const fn base_mut(&mut self) -> &mut EntryBase {
        match self {
            Self::Message(e) => &mut e.base,
            Self::ModelChange(e) => &mut e.base,
            Self::ThinkingLevelChange(e) => &mut e.base,
            Self::Compaction(e) => &mut e.base,
            Self::BranchSummary(e) => &mut e.base,
            Self::Label(e) => &mut e.base,
            Self::SessionInfo(e) => &mut e.base,
            Self::Custom(e) => &mut e.base,
        }
    }

    pub const fn base_id(&self) -> Option<&String> {
        self.base().id.as_ref()
    }
}

/// Base entry fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryBase {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub timestamp: String,
}

impl EntryBase {
    pub fn new(parent_id: Option<String>, id: String) -> Self {
        Self {
            id: Some(id),
            parent_id,
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }
}

/// Message entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEntry {
    #[serde(flatten)]
    pub base: EntryBase,
    pub message: SessionMessage,
}

/// Session message payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum SessionMessage {
    User {
        content: UserContent,
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp: Option<i64>,
    },
    Assistant {
        #[serde(flatten)]
        message: AssistantMessage,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        content: Vec<ContentBlock>,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
        #[serde(default)]
        is_error: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp: Option<i64>,
    },
    Custom {
        custom_type: String,
        content: String,
        #[serde(default)]
        display: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
    },
    BashExecution {
        command: String,
        output: String,
        exit_code: i32,
        #[serde(skip_serializing_if = "Option::is_none")]
        cancelled: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        truncated: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        full_output_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp: Option<i64>,
        #[serde(flatten)]
        extra: HashMap<String, Value>,
    },
    BranchSummary {
        summary: String,
        from_id: String,
    },
    CompactionSummary {
        summary: String,
        tokens_before: u64,
    },
}

impl From<Message> for SessionMessage {
    fn from(message: Message) -> Self {
        match message {
            Message::User(user) => Self::User {
                content: user.content,
                timestamp: Some(user.timestamp),
            },
            Message::Assistant(assistant) => Self::Assistant { message: assistant },
            Message::ToolResult(result) => Self::ToolResult {
                tool_call_id: result.tool_call_id,
                tool_name: result.tool_name,
                content: result.content,
                details: result.details,
                is_error: result.is_error,
                timestamp: Some(result.timestamp),
            },
        }
    }
}

/// Model change entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChangeEntry {
    #[serde(flatten)]
    pub base: EntryBase,
    pub provider: String,
    pub model_id: String,
}

/// Thinking level change entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingLevelChangeEntry {
    #[serde(flatten)]
    pub base: EntryBase,
    pub thinking_level: String,
}

/// Compaction entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionEntry {
    #[serde(flatten)]
    pub base: EntryBase,
    pub summary: String,
    pub first_kept_entry_id: String,
    pub tokens_before: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_hook: Option<bool>,
}

/// Branch summary entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummaryEntry {
    #[serde(flatten)]
    pub base: EntryBase,
    pub from_id: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_hook: Option<bool>,
}

/// Label entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelEntry {
    #[serde(flatten)]
    pub base: EntryBase,
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Session info entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfoEntry {
    #[serde(flatten)]
    pub base: EntryBase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Custom entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomEntry {
    #[serde(flatten)]
    pub base: EntryBase,
    pub custom_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

// ============================================================================
// Utilities
// ============================================================================

/// Encode a working directory path for use in session directory names.
pub fn encode_cwd(path: &std::path::Path) -> String {
    let s = path.display().to_string();
    let s = s.trim_start_matches(['/', '\\']);
    let s = s.replace(['/', '\\', ':'], "-");
    format!("--{s}--")
}

fn session_message_to_model(message: &SessionMessage) -> Option<Message> {
    match message {
        SessionMessage::User { content, timestamp } => Some(Message::User(UserMessage {
            content: content.clone(),
            timestamp: timestamp.unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
        })),
        SessionMessage::Assistant { message } => Some(Message::Assistant(message.clone())),
        SessionMessage::ToolResult {
            tool_call_id,
            tool_name,
            content,
            details,
            is_error,
            timestamp,
        } => Some(Message::ToolResult(ToolResultMessage {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            content: content.clone(),
            details: details.clone(),
            is_error: *is_error,
            timestamp: timestamp.unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
        })),
        _ => None,
    }
}

fn render_session_message(message: &SessionMessage) -> String {
    match message {
        SessionMessage::User { content, .. } => {
            let mut html = String::new();
            html.push_str("<div class=\"msg user\"><div class=\"role\">User</div>");
            html.push_str(&render_user_content(content));
            html.push_str("</div>");
            html
        }
        SessionMessage::Assistant { message } => {
            let mut html = String::new();
            html.push_str("<div class=\"msg assistant\"><div class=\"role\">Assistant</div>");
            html.push_str(&render_blocks(&message.content));
            html.push_str("</div>");
            html
        }
        SessionMessage::ToolResult {
            tool_name,
            content,
            is_error,
            details,
            ..
        } => {
            let mut html = String::new();
            let role = if *is_error { "Tool Error" } else { "Tool" };
            let _ = write!(
                html,
                "<div class=\"msg tool\"><div class=\"role\">{}: {}</div>",
                role,
                escape_html(tool_name)
            );
            html.push_str(&render_blocks(content));
            if let Some(details) = details {
                let details_str =
                    serde_json::to_string_pretty(details).unwrap_or_else(|_| details.to_string());
                let _ = write!(html, "<pre>{}</pre>", escape_html(&details_str));
            }
            html.push_str("</div>");
            html
        }
        SessionMessage::Custom {
            custom_type,
            content,
            ..
        } => {
            let mut html = String::new();
            let _ = write!(
                html,
                "<div class=\"msg system\"><div class=\"role\">{}</div><pre>{}</pre></div>",
                escape_html(custom_type),
                escape_html(content)
            );
            html
        }
        SessionMessage::BashExecution {
            command,
            output,
            exit_code,
            ..
        } => {
            let mut html = String::new();
            let _ = write!(
                html,
                "<div class=\"msg tool\"><div class=\"role\">Bash (exit {exit_code})</div><pre>{}</pre><pre>{}</pre></div>",
                escape_html(command),
                escape_html(output)
            );
            html
        }
        SessionMessage::BranchSummary { summary, .. } => {
            format!(
                "<div class=\"msg system\"><div class=\"role\">Branch Summary</div><pre>{}</pre></div>",
                escape_html(summary)
            )
        }
        SessionMessage::CompactionSummary { summary, .. } => {
            format!(
                "<div class=\"msg system\"><div class=\"role\">Compaction</div><pre>{}</pre></div>",
                escape_html(summary)
            )
        }
    }
}

fn render_user_content(content: &UserContent) -> String {
    match content {
        UserContent::Text(text) => format!("<pre>{}</pre>", escape_html(text)),
        UserContent::Blocks(blocks) => render_blocks(blocks),
    }
}

fn render_blocks(blocks: &[ContentBlock]) -> String {
    let mut html = String::new();
    for block in blocks {
        match block {
            ContentBlock::Text(text) => {
                let _ = write!(html, "<pre>{}</pre>", escape_html(&text.text));
            }
            ContentBlock::Thinking(thinking) => {
                let _ = write!(
                    html,
                    "<details class=\"thinking\"><summary>Thinking</summary><pre>{}</pre></details>",
                    escape_html(&thinking.thinking)
                );
            }
            ContentBlock::Image(image) => {
                let _ = write!(
                    html,
                    "<img src=\"data:{};base64,{}\" alt=\"image\"/>",
                    escape_html(&image.mime_type),
                    escape_html(&image.data)
                );
            }
            ContentBlock::ToolCall(tool_call) => {
                let args = serde_json::to_string_pretty(&tool_call.arguments)
                    .unwrap_or_else(|_| tool_call.arguments.to_string());
                let _ = write!(
                    html,
                    "<div class=\"note\">Tool call: {}</div><pre>{}</pre>",
                    escape_html(&tool_call.name),
                    escape_html(&args)
                );
            }
        }
    }
    html
}

fn escape_html(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn entry_id_set(entries: &[SessionEntry]) -> HashSet<String> {
    entries
        .iter()
        .filter_map(|e| e.base_id().cloned())
        .collect()
}

fn ensure_entry_ids(entries: &mut [SessionEntry]) {
    let mut existing = entry_id_set(entries);
    for entry in entries.iter_mut() {
        if entry.base().id.is_none() {
            let id = generate_entry_id(&existing);
            entry.base_mut().id = Some(id.clone());
            existing.insert(id);
        }
    }
}

/// Generate a unique entry ID (8 hex characters), falling back to UUID on collision.
fn generate_entry_id(existing: &HashSet<String>) -> String {
    for _ in 0..100 {
        let uuid = uuid::Uuid::new_v4();
        let id = uuid.simple().to_string()[..8].to_string();
        if !existing.contains(&id) {
            return id;
        }
    }
    uuid::Uuid::new_v4().to_string()
}
