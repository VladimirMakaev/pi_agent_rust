//! Built-in tool implementations.
//!
//! Pi provides 7 built-in tools: read, bash, edit, write, grep, find, ls.

use crate::error::{Error, Result};
use crate::model::{ContentBlock, ImageContent, TextContent};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

// ============================================================================
// Tool Trait
// ============================================================================

/// A tool that can be executed by the agent.
#[async_trait]
pub trait Tool: Send + Sync {
    /// Get the tool name.
    fn name(&self) -> &'static str;

    /// Get the tool label (display name).
    fn label(&self) -> &'static str;

    /// Get the tool description.
    fn description(&self) -> &'static str;

    /// Get the tool parameters as JSON Schema.
    fn parameters(&self) -> serde_json::Value;

    /// Execute the tool.
    async fn execute(
        &self,
        tool_call_id: &str,
        input: serde_json::Value,
        on_update: Option<Box<dyn Fn(ToolUpdate) + Send>>,
    ) -> Result<ToolOutput>;
}

/// Tool execution output.
pub struct ToolOutput {
    pub content: Vec<ContentBlock>,
    pub details: Option<serde_json::Value>,
}

/// Incremental update during tool execution.
pub struct ToolUpdate {
    pub content: Vec<ContentBlock>,
    pub details: Option<serde_json::Value>,
}

// ============================================================================
// Truncation
// ============================================================================

/// Default maximum lines for truncation.
pub const DEFAULT_MAX_LINES: usize = 2000;

/// Default maximum bytes for truncation.
pub const DEFAULT_MAX_BYTES: usize = 50 * 1024; // 50KB

/// Maximum line length for grep results.
pub const GREP_MAX_LINE_LENGTH: usize = 500;

/// Default bash timeout in seconds.
pub const DEFAULT_BASH_TIMEOUT: u64 = 120;

/// Result of truncation operation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncationResult {
    pub content: String,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated_by: Option<TruncatedBy>,
    pub total_lines: usize,
    pub total_bytes: usize,
    pub output_lines: usize,
    pub output_bytes: usize,
    pub last_line_partial: bool,
    pub first_line_exceeds_limit: bool,
    pub max_lines: usize,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TruncatedBy {
    Lines,
    Bytes,
}

/// Truncate from the beginning (keep first N lines).
pub fn truncate_head(content: &str, max_lines: usize, max_bytes: usize) -> TruncationResult {
    let total_bytes = content.len();
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();

    // No truncation needed
    if total_lines <= max_lines && total_bytes <= max_bytes {
        return TruncationResult {
            content: content.to_string(),
            truncated: false,
            truncated_by: None,
            total_lines,
            total_bytes,
            output_lines: total_lines,
            output_bytes: total_bytes,
            last_line_partial: false,
            first_line_exceeds_limit: false,
            max_lines,
            max_bytes,
        };
    }

    // If the first line alone exceeds the byte limit, return empty content.
    let first_line_bytes = lines.first().map_or(0, |l| l.len());
    if first_line_bytes > max_bytes {
        return TruncationResult {
            content: String::new(),
            truncated: true,
            truncated_by: Some(TruncatedBy::Bytes),
            total_lines,
            total_bytes,
            output_lines: 0,
            output_bytes: 0,
            last_line_partial: false,
            first_line_exceeds_limit: true,
            max_lines,
            max_bytes,
        };
    }

    let mut output = String::new();
    let mut line_count = 0;
    let mut byte_count: usize = 0;
    let mut truncated_by = None;

    for (i, line) in lines.iter().enumerate() {
        if i >= max_lines {
            truncated_by = Some(TruncatedBy::Lines);
            break;
        }

        let line_bytes = line.len() + usize::from(i > 0); // +1 for newline
        if line_count >= max_lines {
            truncated_by = Some(TruncatedBy::Lines);
            break;
        }

        if byte_count + line_bytes > max_bytes {
            truncated_by = Some(TruncatedBy::Bytes);
            break;
        }

        if i > 0 {
            output.push('\n');
        }
        output.push_str(line);
        line_count += 1;
        byte_count += line_bytes;
    }

    let output_bytes = output.len();

    TruncationResult {
        content: output,
        truncated: truncated_by.is_some(),
        truncated_by,
        total_lines,
        total_bytes,
        output_lines: line_count,
        output_bytes,
        last_line_partial: false,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

/// Truncate from the end (keep last N lines).
pub fn truncate_tail(content: &str, max_lines: usize, max_bytes: usize) -> TruncationResult {
    let total_bytes = content.len();
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();

    // No truncation needed
    if total_lines <= max_lines && total_bytes <= max_bytes {
        return TruncationResult {
            content: content.to_string(),
            truncated: false,
            truncated_by: None,
            total_lines,
            total_bytes,
            output_lines: total_lines,
            output_bytes: total_bytes,
            last_line_partial: false,
            first_line_exceeds_limit: false,
            max_lines,
            max_bytes,
        };
    }

    let mut output_lines = Vec::new();
    let mut byte_count: usize = 0;
    let mut truncated_by = None;
    let mut last_line_partial = false;

    // Iterate from the end
    for line in lines.iter().rev() {
        let line_bytes = line.len() + usize::from(!output_lines.is_empty());

        if output_lines.len() >= max_lines {
            truncated_by = Some(TruncatedBy::Lines);
            break;
        }

        if byte_count + line_bytes > max_bytes {
            // Check if we can include a partial last line
            let remaining = max_bytes.saturating_sub(byte_count);
            if remaining > 0 && output_lines.is_empty() {
                output_lines.push(truncate_string_to_bytes_from_end(line, max_bytes));
                last_line_partial = true;
            }
            truncated_by = Some(TruncatedBy::Bytes);
            break;
        }

        output_lines.push((*line).to_string());
        byte_count += line_bytes;
    }

    output_lines.reverse();
    let output = output_lines.join("\n");
    let output_bytes = output.len();

    TruncationResult {
        content: output,
        truncated: truncated_by.is_some(),
        truncated_by,
        total_lines,
        total_bytes,
        output_lines: output_lines.len(),
        output_bytes,
        last_line_partial,
        first_line_exceeds_limit: false,
        max_lines,
        max_bytes,
    }
}

/// Truncate a string to fit within a byte limit (from the end), preserving UTF-8 boundaries.
fn truncate_string_to_bytes_from_end(s: &str, max_bytes: usize) -> String {
    let bytes = s.as_bytes();
    if bytes.len() <= max_bytes {
        return s.to_string();
    }

    let mut start = bytes.len().saturating_sub(max_bytes);
    while start < bytes.len() && (bytes[start] & 0b1100_0000) == 0b1000_0000 {
        start += 1;
    }

    std::str::from_utf8(&bytes[start..])
        .map(str::to_string)
        .unwrap_or_default()
}

// ============================================================================
// Path Utilities (port of pi-mono path-utils.ts)
// ============================================================================

fn is_special_unicode_space(c: char) -> bool {
    matches!(c, '\u{00A0}' | '\u{202F}' | '\u{205F}' | '\u{3000}')
        || ('\u{2000}'..='\u{200A}').contains(&c)
}

fn normalize_unicode_spaces(s: &str) -> String {
    s.chars()
        .map(|c| if is_special_unicode_space(c) { ' ' } else { c })
        .collect()
}

fn expand_path(file_path: &str) -> String {
    let normalized = normalize_unicode_spaces(file_path);
    if normalized == "~" {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("~"))
            .to_string_lossy()
            .to_string();
    }
    if let Some(rest) = normalized.strip_prefix("~/") {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("~"));
        return home.join(rest).to_string_lossy().to_string();
    }
    normalized
}

/// Resolve a path relative to `cwd`. Handles `~` expansion and absolute paths.
fn resolve_to_cwd(file_path: &str, cwd: &Path) -> PathBuf {
    let expanded = expand_path(file_path);
    let expanded_path = PathBuf::from(expanded);
    if expanded_path.is_absolute() {
        expanded_path
    } else {
        cwd.join(expanded_path)
    }
}

fn try_mac_os_screenshot_path(file_path: &str) -> String {
    // Replace " AM." / " PM." with a narrow no-break space variant used by macOS screenshots.
    file_path
        .replace(" AM.", "\u{202F}AM.")
        .replace(" PM.", "\u{202F}PM.")
}

fn try_curly_quote_variant(file_path: &str) -> String {
    // Replace straight apostrophe with macOS screenshot curly apostrophe.
    file_path.replace('\'', "\u{2019}")
}

fn try_nfd_variant(file_path: &str) -> String {
    // NFD normalization - decompose characters into base + combining marks
    // This handles macOS HFS+ filesystem normalization differences
    use unicode_normalization::UnicodeNormalization;
    file_path.nfd().collect::<String>()
}

fn file_exists(path: &Path) -> bool {
    std::fs::metadata(path).is_ok()
}

/// Resolve a file path for reading, including macOS screenshot name variants.
fn resolve_read_path(file_path: &str, cwd: &Path) -> PathBuf {
    let resolved = resolve_to_cwd(file_path, cwd);
    if file_exists(&resolved) {
        return resolved;
    }

    let Some(resolved_str) = resolved.to_str() else {
        return resolved;
    };

    let am_pm_variant = try_mac_os_screenshot_path(resolved_str);
    if am_pm_variant != resolved_str && file_exists(Path::new(&am_pm_variant)) {
        return PathBuf::from(am_pm_variant);
    }

    let nfd_variant = try_nfd_variant(resolved_str);
    if nfd_variant != resolved_str && file_exists(Path::new(&nfd_variant)) {
        return PathBuf::from(nfd_variant);
    }

    let curly_variant = try_curly_quote_variant(resolved_str);
    if curly_variant != resolved_str && file_exists(Path::new(&curly_variant)) {
        return PathBuf::from(curly_variant);
    }

    let nfd_curly_variant = try_curly_quote_variant(&nfd_variant);
    if nfd_curly_variant != resolved_str && file_exists(Path::new(&nfd_curly_variant)) {
        return PathBuf::from(nfd_curly_variant);
    }

    resolved
}

/// Resolve a file path relative to the current working directory.
/// Public alias for `resolve_to_cwd` used by tools.
fn resolve_path(file_path: &str, cwd: &Path) -> PathBuf {
    resolve_to_cwd(file_path, cwd)
}

/// Check if a file is an image based on extension.
fn is_image_file(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    matches!(
        ext.to_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "ico" | "tiff" | "tif"
    )
}

/// Get the MIME type for an image file based on extension.
fn image_mime_type(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tiff" | "tif" => "image/tiff",
        _ => "application/octet-stream",
    }
}

/// Add line numbers to content (cat -n style).
fn add_line_numbers(content: &str, start_line: usize) -> String {
    content
        .lines()
        .enumerate()
        .map(|(i, line)| format!("{}\t{}", start_line + i, line))
        .collect::<Vec<_>>()
        .join("\n")
}

// ============================================================================
// Tool Registry
// ============================================================================

/// Registry of available tools.
pub struct ToolRegistry {
    tools: Vec<Box<dyn Tool>>,
}

impl ToolRegistry {
    /// Create a new registry with the specified tools enabled.
    pub fn new(enabled: &[&str], cwd: &Path) -> Self {
        let mut tools: Vec<Box<dyn Tool>> = Vec::new();

        for name in enabled {
            match *name {
                "read" => tools.push(Box::new(ReadTool::new(cwd))),
                "bash" => tools.push(Box::new(BashTool::new(cwd))),
                "edit" => tools.push(Box::new(EditTool::new(cwd))),
                "write" => tools.push(Box::new(WriteTool::new(cwd))),
                "grep" => tools.push(Box::new(GrepTool::new(cwd))),
                "find" => tools.push(Box::new(FindTool::new(cwd))),
                "ls" => tools.push(Box::new(LsTool::new(cwd))),
                _ => {}
            }
        }

        Self { tools }
    }

    /// Get all tools.
    pub fn tools(&self) -> &[Box<dyn Tool>] {
        &self.tools
    }

    /// Find a tool by name.
    pub fn get(&self, name: &str) -> Option<&dyn Tool> {
        self.tools
            .iter()
            .find(|t| t.name() == name)
            .map(std::convert::AsRef::as_ref)
    }
}

// ============================================================================
// Read Tool
// ============================================================================

/// Input parameters for the read tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadInput {
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

pub struct ReadTool {
    cwd: PathBuf,
}

impl ReadTool {
    pub fn new(cwd: &Path) -> Self {
        Self {
            cwd: cwd.to_path_buf(),
        }
    }
}

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &'static str {
        "read"
    }
    fn label(&self) -> &'static str {
        "Read File"
    }
    fn description(&self) -> &'static str {
        "Read file contents with optional line offset and limit"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path (absolute, relative, or ~-prefixed)"
                },
                "offset": {
                    "type": "integer",
                    "description": "Line to start from (1-indexed, default: 1)",
                    "minimum": 1
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum lines to read (default: 2000)",
                    "minimum": 1
                }
            },
            "required": ["path"]
        })
    }

    async fn execute(
        &self,
        _tool_call_id: &str,
        input: serde_json::Value,
        _on_update: Option<Box<dyn Fn(ToolUpdate) + Send>>,
    ) -> Result<ToolOutput> {
        let input: ReadInput =
            serde_json::from_value(input).map_err(|e| Error::validation(e.to_string()))?;

        let path = resolve_path(&input.path, &self.cwd);
        let offset = input.offset.unwrap_or(1).max(1);
        let limit = input.limit.unwrap_or(DEFAULT_MAX_LINES);

        // Check if file exists
        if !path.exists() {
            return Err(Error::tool(
                "read",
                format!("File not found: {}", path.display()),
            ));
        }

        // Check if it's a directory
        if path.is_dir() {
            return Err(Error::tool(
                "read",
                format!("Path is a directory: {}", path.display()),
            ));
        }

        // Handle image files
        if is_image_file(&path) {
            let data = tokio::fs::read(&path)
                .await
                .map_err(|e| Error::tool("read", e.to_string()))?;
            let base64_data =
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
            let mime_type = image_mime_type(&path);

            return Ok(ToolOutput {
                content: vec![ContentBlock::Image(ImageContent {
                    data: base64_data,
                    mime_type: mime_type.to_string(),
                })],
                details: Some(serde_json::json!({
                    "path": path.display().to_string(),
                    "size": data.len(),
                    "mimeType": mime_type,
                })),
            });
        }

        // Read text file
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| Error::tool("read", format!("Failed to read file: {e}")))?;

        // Apply offset and limit
        let lines: Vec<&str> = content.lines().collect();
        let total_lines = lines.len();
        let start_idx = (offset - 1).min(total_lines);
        let end_idx = (start_idx + limit).min(total_lines);
        let selected_lines: Vec<&str> = lines[start_idx..end_idx].to_vec();
        let selected_content = selected_lines.join("\n");

        // Apply truncation (by bytes)
        let result = truncate_head(&selected_content, limit, DEFAULT_MAX_BYTES);

        // Add line numbers
        let numbered_content = add_line_numbers(&result.content, offset);

        Ok(ToolOutput {
            content: vec![ContentBlock::Text(TextContent::new(numbered_content))],
            details: Some(serde_json::json!({
                "path": path.display().to_string(),
                "totalLines": total_lines,
                "offset": offset,
                "limit": limit,
                "outputLines": result.output_lines,
                "truncated": result.truncated,
                "truncatedBy": result.truncated_by,
            })),
        })
    }
}

// ============================================================================
// Bash Tool
// ============================================================================

/// Input parameters for the bash tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BashInput {
    command: String,
    timeout: Option<u64>,
}

pub struct BashTool {
    cwd: PathBuf,
}

impl BashTool {
    pub fn new(cwd: &Path) -> Self {
        Self {
            cwd: cwd.to_path_buf(),
        }
    }
}

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &'static str {
        "bash"
    }
    fn label(&self) -> &'static str {
        "Bash"
    }
    fn description(&self) -> &'static str {
        "Execute bash commands"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Bash command to execute"
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds (default: 120)",
                    "minimum": 1
                }
            },
            "required": ["command"]
        })
    }

    #[allow(clippy::too_many_lines)]
    async fn execute(
        &self,
        _tool_call_id: &str,
        input: serde_json::Value,
        on_update: Option<Box<dyn Fn(ToolUpdate) + Send>>,
    ) -> Result<ToolOutput> {
        let input: BashInput =
            serde_json::from_value(input).map_err(|e| Error::validation(e.to_string()))?;

        let timeout_secs = input.timeout.unwrap_or(DEFAULT_BASH_TIMEOUT);

        // Spawn the bash process
        let mut child = Command::new("bash")
            .arg("-c")
            .arg(&input.command)
            .current_dir(&self.cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::tool("bash", format!("Failed to spawn bash: {e}")))?;

        let stdout = child.stdout.take().expect("stdout should be piped");
        let stderr = child.stderr.take().expect("stderr should be piped");

        let mut stdout_reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();

        let mut output = String::new();

        // Stream output with timeout
        let timeout = tokio::time::Duration::from_secs(timeout_secs);
        let start = tokio::time::Instant::now();

        loop {
            if start.elapsed() > timeout {
                let _ = child.kill().await;
                return Ok(ToolOutput {
                    content: vec![ContentBlock::Text(TextContent::new(format!(
                        "{output}\n\n[Command timed out after {timeout_secs}s]"
                    )))],
                    details: Some(serde_json::json!({
                        "exitCode": null,
                        "timedOut": true,
                        "timeout": timeout_secs,
                    })),
                });
            }

            tokio::select! {
                line = stdout_reader.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            if !output.is_empty() {
                                output.push('\n');
                            }
                            output.push_str(&line);
                            // Send incremental update if callback provided
                            if let Some(ref callback) = on_update {
                                callback(ToolUpdate {
                                    content: vec![ContentBlock::Text(TextContent::new(line))],
                                    details: None,
                                });
                            }
                        }
                        Ok(None) => {}
                        Err(e) => {
                            tracing::warn!("Error reading stdout: {e}");
                        }
                    }
                }
                line = stderr_reader.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            if !output.is_empty() {
                                output.push('\n');
                            }
                            output.push_str(&line);
                            // Send incremental update
                            if let Some(ref callback) = on_update {
                                callback(ToolUpdate {
                                    content: vec![ContentBlock::Text(TextContent::new(line))],
                                    details: None,
                                });
                            }
                        }
                        Ok(None) => {}
                        Err(e) => {
                            tracing::warn!("Error reading stderr: {e}");
                        }
                    }
                }
                status = child.wait() => {
                    let exit_code = status
                        .map_err(|e| Error::tool("bash", e.to_string()))?
                        .code();

                    // Apply tail truncation
                    let result = truncate_tail(&output, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);

                    let content = if result.truncated {
                        format!(
                            "[Output truncated: showing last {} of {} lines]\n{}",
                            result.output_lines, result.total_lines, result.content
                        )
                    } else {
                        result.content
                    };

                    return Ok(ToolOutput {
                        content: vec![ContentBlock::Text(TextContent::new(content))],
                        details: Some(serde_json::json!({
                            "exitCode": exit_code,
                            "timedOut": false,
                            "totalLines": result.total_lines,
                            "outputLines": result.output_lines,
                            "truncated": result.truncated,
                        })),
                    });
                }
            }
        }
    }
}

// ============================================================================
// Edit Tool
// ============================================================================

/// Input parameters for the edit tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditInput {
    path: String,
    old_text: String,
    new_text: String,
}

pub struct EditTool {
    cwd: PathBuf,
}

impl EditTool {
    pub fn new(cwd: &Path) -> Self {
        Self {
            cwd: cwd.to_path_buf(),
        }
    }
}

/// Compute a simple unified diff.
fn compute_diff(old: &str, new: &str, path: &str) -> String {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    let mut diff = format!("--- a/{path}\n+++ b/{path}\n");

    // Simple line-by-line diff (not optimal, but works for small edits)
    let mut i = 0;
    let mut j = 0;

    while i < old_lines.len() || j < new_lines.len() {
        if i < old_lines.len() && j < new_lines.len() && old_lines[i] == new_lines[j] {
            i += 1;
            j += 1;
        } else {
            // Find the extent of the change
            let old_start = i;
            let new_start = j;

            // Skip differing lines
            while i < old_lines.len()
                && (j >= new_lines.len() || old_lines[i] != *new_lines.get(j).unwrap_or(&""))
            {
                i += 1;
            }
            while j < new_lines.len()
                && (i >= old_lines.len() || new_lines[j] != *old_lines.get(i).unwrap_or(&""))
            {
                j += 1;
            }

            // Output the hunk
            let old_count = i - old_start;
            let new_count = j - new_start;

            let _ = writeln!(
                diff,
                "@@ -{},{} +{},{} @@",
                old_start + 1,
                old_count,
                new_start + 1,
                new_count
            );

            for line in &old_lines[old_start..i] {
                let _ = writeln!(diff, "-{line}");
            }
            for line in &new_lines[new_start..j] {
                let _ = writeln!(diff, "+{line}");
            }
        }
    }

    diff
}

#[async_trait]
impl Tool for EditTool {
    fn name(&self) -> &'static str {
        "edit"
    }
    fn label(&self) -> &'static str {
        "Edit"
    }
    fn description(&self) -> &'static str {
        "Replace exact text in a file"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path to edit"
                },
                "oldText": {
                    "type": "string",
                    "description": "Exact text to find and replace"
                },
                "newText": {
                    "type": "string",
                    "description": "Replacement text"
                }
            },
            "required": ["path", "oldText", "newText"]
        })
    }

    async fn execute(
        &self,
        _tool_call_id: &str,
        input: serde_json::Value,
        _on_update: Option<Box<dyn Fn(ToolUpdate) + Send>>,
    ) -> Result<ToolOutput> {
        let input: EditInput =
            serde_json::from_value(input).map_err(|e| Error::validation(e.to_string()))?;

        let path = resolve_path(&input.path, &self.cwd);

        // Check if file exists
        if !path.exists() {
            return Err(Error::tool(
                "edit",
                format!("File not found: {}", path.display()),
            ));
        }

        // Read the file
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| Error::tool("edit", format!("Failed to read file: {e}")))?;

        // Check if oldText exists in the file
        if !content.contains(&input.old_text) {
            return Err(Error::tool(
                "edit",
                "Text not found in file. Make sure the oldText matches exactly, including whitespace.".to_string(),
            ));
        }

        // Check for multiple occurrences
        let occurrences = content.matches(&input.old_text).count();
        if occurrences > 1 {
            return Err(Error::tool(
                "edit",
                format!(
                    "Found {occurrences} occurrences of the text. Please provide more context to make the match unique."
                ),
            ));
        }

        // Perform the replacement
        let new_content = content.replacen(&input.old_text, &input.new_text, 1);

        // Compute diff
        let diff = compute_diff(&content, &new_content, &input.path);

        // Write atomically using tempfile
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let temp_file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| Error::tool("edit", format!("Failed to create temp file: {e}")))?;

        tokio::fs::write(temp_file.path(), &new_content)
            .await
            .map_err(|e| Error::tool("edit", format!("Failed to write temp file: {e}")))?;

        // Persist (atomic rename)
        temp_file
            .persist(&path)
            .map_err(|e| Error::tool("edit", format!("Failed to persist file: {e}")))?;

        Ok(ToolOutput {
            content: vec![ContentBlock::Text(TextContent::new(diff))],
            details: Some(serde_json::json!({
                "path": path.display().to_string(),
                "oldLength": input.old_text.len(),
                "newLength": input.new_text.len(),
            })),
        })
    }
}

// ============================================================================
// Write Tool
// ============================================================================

/// Input parameters for the write tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteInput {
    path: String,
    content: String,
}

pub struct WriteTool {
    cwd: PathBuf,
}

impl WriteTool {
    pub fn new(cwd: &Path) -> Self {
        Self {
            cwd: cwd.to_path_buf(),
        }
    }
}

#[async_trait]
impl Tool for WriteTool {
    fn name(&self) -> &'static str {
        "write"
    }
    fn label(&self) -> &'static str {
        "Write"
    }
    fn description(&self) -> &'static str {
        "Write content to a file"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path to write"
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file"
                }
            },
            "required": ["path", "content"]
        })
    }

    async fn execute(
        &self,
        _tool_call_id: &str,
        input: serde_json::Value,
        _on_update: Option<Box<dyn Fn(ToolUpdate) + Send>>,
    ) -> Result<ToolOutput> {
        let input: WriteInput =
            serde_json::from_value(input).map_err(|e| Error::validation(e.to_string()))?;

        let path = resolve_path(&input.path, &self.cwd);

        // Create parent directories if needed
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| Error::tool("write", format!("Failed to create directories: {e}")))?;
        }

        let bytes_written = input.content.len();

        // Write atomically using tempfile
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let temp_file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| Error::tool("write", format!("Failed to create temp file: {e}")))?;

        tokio::fs::write(temp_file.path(), &input.content)
            .await
            .map_err(|e| Error::tool("write", format!("Failed to write temp file: {e}")))?;

        // Persist (atomic rename)
        temp_file
            .persist(&path)
            .map_err(|e| Error::tool("write", format!("Failed to persist file: {e}")))?;

        Ok(ToolOutput {
            content: vec![ContentBlock::Text(TextContent::new(format!(
                "Wrote {} bytes to {}",
                bytes_written,
                path.display()
            )))],
            details: Some(serde_json::json!({
                "path": path.display().to_string(),
                "bytesWritten": bytes_written,
                "lines": input.content.lines().count(),
            })),
        })
    }
}

// ============================================================================
// Grep Tool
// ============================================================================

/// Input parameters for the grep tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrepInput {
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    ignore_case: Option<bool>,
    literal: Option<bool>,
    context: Option<usize>,
    limit: Option<usize>,
}

pub struct GrepTool {
    cwd: PathBuf,
}

impl GrepTool {
    pub fn new(cwd: &Path) -> Self {
        Self {
            cwd: cwd.to_path_buf(),
        }
    }
}

/// Result of truncating a single grep output line.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TruncateLineResult {
    text: String,
    was_truncated: bool,
}

/// Truncate a single line to max characters, adding a marker suffix.
///
/// Matches pi-mono behavior: `${line.slice(0, maxChars)}... [truncated]`.
fn truncate_line(line: &str, max_chars: usize) -> TruncateLineResult {
    let mut chars = line.chars();
    let prefix: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_none() {
        return TruncateLineResult {
            text: line.to_string(),
            was_truncated: false,
        };
    }

    TruncateLineResult {
        text: format!("{prefix}... [truncated]"),
        was_truncated: true,
    }
}

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &'static str {
        "grep"
    }
    fn label(&self) -> &'static str {
        "Grep"
    }
    fn description(&self) -> &'static str {
        "Search file contents using regex patterns"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern to search for"
                },
                "path": {
                    "type": "string",
                    "description": "Directory or file to search (default: current directory)"
                },
                "glob": {
                    "type": "string",
                    "description": "Glob pattern to filter files (e.g., '*.rs')"
                },
                "ignoreCase": {
                    "type": "boolean",
                    "description": "Case-insensitive search"
                },
                "literal": {
                    "type": "boolean",
                    "description": "Treat pattern as literal string, not regex"
                },
                "context": {
                    "type": "integer",
                    "description": "Number of context lines before and after matches"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of matches to return"
                }
            },
            "required": ["pattern"]
        })
    }

    #[allow(clippy::too_many_lines)]
    async fn execute(
        &self,
        _tool_call_id: &str,
        input: serde_json::Value,
        _on_update: Option<Box<dyn Fn(ToolUpdate) + Send>>,
    ) -> Result<ToolOutput> {
        let input: GrepInput =
            serde_json::from_value(input).map_err(|e| Error::validation(e.to_string()))?;

        let search_path = input
            .path
            .as_ref()
            .map_or_else(|| self.cwd.clone(), |p| resolve_path(p, &self.cwd));

        let limit = input.limit.unwrap_or(100);
        let context = input.context.unwrap_or(0);

        // Build regex
        let pattern = if input.literal.unwrap_or(false) {
            regex::escape(&input.pattern)
        } else {
            input.pattern.clone()
        };

        let regex = if input.ignore_case.unwrap_or(false) {
            regex::RegexBuilder::new(&pattern)
                .case_insensitive(true)
                .build()
        } else {
            regex::Regex::new(&pattern)
        }
        .map_err(|e| Error::tool("grep", format!("Invalid regex: {e}")))?;

        // Build file walker
        let mut builder = ignore::WalkBuilder::new(&search_path);
        builder.hidden(false).git_ignore(true).git_exclude(true);

        // Apply glob filter if specified
        let glob_matcher = input
            .glob
            .as_ref()
            .map(|g| glob::Pattern::new(g))
            .transpose()
            .map_err(|e| Error::tool("grep", format!("Invalid glob: {e}")))?;

        let mut results: Vec<String> = Vec::new();
        let mut match_count = 0;
        let mut files_searched = 0;
        let mut files_with_matches = 0;

        for entry in builder.build() {
            if match_count >= limit {
                break;
            }

            let Ok(entry) = entry else {
                continue;
            };

            let path = entry.path();

            // Skip directories
            if path.is_dir() {
                continue;
            }

            // Apply glob filter
            if let Some(ref matcher) = glob_matcher {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !matcher.matches(file_name) {
                    continue;
                }
            }

            files_searched += 1;

            // Read file - skip binary/unreadable files
            let Ok(file_content) = std::fs::read_to_string(path) else {
                continue;
            };

            let lines: Vec<&str> = file_content.lines().collect();
            let mut file_matches = Vec::new();

            for (line_num, line) in lines.iter().enumerate() {
                if match_count >= limit {
                    break;
                }

                if regex.is_match(line) {
                    match_count += 1;

                    // Get context lines
                    let start = line_num.saturating_sub(context);
                    let end = (line_num + context + 1).min(lines.len());

                    for (idx, context_line) in lines.iter().enumerate().take(end).skip(start) {
                        let prefix = if idx == line_num { ">" } else { " " };
                        let truncated = truncate_line(context_line, GREP_MAX_LINE_LENGTH);
                        file_matches.push(format!("{}{:6}:{}", prefix, idx + 1, truncated.text));
                    }

                    if context > 0 && end < lines.len() {
                        file_matches.push("--".to_string());
                    }
                }
            }

            if !file_matches.is_empty() {
                files_with_matches += 1;
                let relative_path = path
                    .strip_prefix(&self.cwd)
                    .unwrap_or(path)
                    .display()
                    .to_string();
                results.push(format!("{}:\n{}", relative_path, file_matches.join("\n")));
            }
        }

        let output = if results.is_empty() {
            "No matches found".to_string()
        } else {
            results.join("\n\n")
        };

        Ok(ToolOutput {
            content: vec![ContentBlock::Text(TextContent::new(output))],
            details: Some(serde_json::json!({
                "matchCount": match_count,
                "filesSearched": files_searched,
                "filesWithMatches": files_with_matches,
                "limit": limit,
                "limitReached": match_count >= limit,
            })),
        })
    }
}

// ============================================================================
// Find Tool
// ============================================================================

/// Input parameters for the find tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindInput {
    pattern: String,
    path: Option<String>,
    limit: Option<usize>,
}

pub struct FindTool {
    cwd: PathBuf,
}

impl FindTool {
    pub fn new(cwd: &Path) -> Self {
        Self {
            cwd: cwd.to_path_buf(),
        }
    }
}

#[async_trait]
impl Tool for FindTool {
    fn name(&self) -> &'static str {
        "find"
    }
    fn label(&self) -> &'static str {
        "Find"
    }
    fn description(&self) -> &'static str {
        "Find files by glob pattern"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern to match files (e.g., '**/*.rs', 'src/*.ts')"
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search (default: current directory)"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of results (default: 100)"
                }
            },
            "required": ["pattern"]
        })
    }

    async fn execute(
        &self,
        _tool_call_id: &str,
        input: serde_json::Value,
        _on_update: Option<Box<dyn Fn(ToolUpdate) + Send>>,
    ) -> Result<ToolOutput> {
        let input: FindInput =
            serde_json::from_value(input).map_err(|e| Error::validation(e.to_string()))?;

        let search_path = input
            .path
            .as_ref()
            .map_or_else(|| self.cwd.clone(), |p| resolve_path(p, &self.cwd));

        let limit = input.limit.unwrap_or(100);

        // Build glob pattern
        let full_pattern = search_path.join(&input.pattern);
        let pattern_str = full_pattern.to_string_lossy();

        let paths = glob::glob(&pattern_str)
            .map_err(|e| Error::tool("find", format!("Invalid glob pattern: {e}")))?;

        // Collect and sort by modification time (newest first)
        let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();

        for entry in paths {
            if entries.len() >= limit * 2 {
                // Collect extra for sorting
                break;
            }

            let Ok(path) = entry else { continue };

            if path.is_dir() {
                continue;
            }

            let mtime = path
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);

            entries.push((path, mtime));
        }

        // Sort by modification time (newest first)
        entries.sort_by_key(|entry| Reverse(entry.1));

        // Take only limit entries
        let entries: Vec<_> = entries.into_iter().take(limit).collect();
        let count = entries.len();

        // Format output
        let output: Vec<String> = entries
            .iter()
            .map(|(path, _)| {
                path.strip_prefix(&self.cwd)
                    .unwrap_or(path)
                    .display()
                    .to_string()
            })
            .collect();

        let result = if output.is_empty() {
            "No files found".to_string()
        } else {
            output.join("\n")
        };

        Ok(ToolOutput {
            content: vec![ContentBlock::Text(TextContent::new(result))],
            details: Some(serde_json::json!({
                "count": count,
                "limit": limit,
                "pattern": input.pattern,
            })),
        })
    }
}

// ============================================================================
// Ls Tool
// ============================================================================

/// Input parameters for the ls tool.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LsInput {
    path: Option<String>,
    limit: Option<usize>,
}

pub struct LsTool {
    cwd: PathBuf,
}

impl LsTool {
    pub fn new(cwd: &Path) -> Self {
        Self {
            cwd: cwd.to_path_buf(),
        }
    }
}

/// Format file size in human-readable form.
#[allow(clippy::cast_precision_loss)] // File sizes won't exceed f64 mantissa precision
fn format_size(size: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if size >= GB {
        format!("{:.1}G", size as f64 / GB as f64)
    } else if size >= MB {
        format!("{:.1}M", size as f64 / MB as f64)
    } else if size >= KB {
        format!("{:.1}K", size as f64 / KB as f64)
    } else {
        format!("{size}B")
    }
}

#[async_trait]
impl Tool for LsTool {
    fn name(&self) -> &'static str {
        "ls"
    }
    fn label(&self) -> &'static str {
        "List"
    }
    fn description(&self) -> &'static str {
        "List directory contents"
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory to list (default: current directory)"
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of entries (default: 100)"
                }
            }
        })
    }

    async fn execute(
        &self,
        _tool_call_id: &str,
        input: serde_json::Value,
        _on_update: Option<Box<dyn Fn(ToolUpdate) + Send>>,
    ) -> Result<ToolOutput> {
        let input: LsInput =
            serde_json::from_value(input).map_err(|e| Error::validation(e.to_string()))?;

        let dir_path = input
            .path
            .as_ref()
            .map_or_else(|| self.cwd.clone(), |p| resolve_path(p, &self.cwd));

        let limit = input.limit.unwrap_or(100);

        if !dir_path.exists() {
            return Err(Error::tool(
                "ls",
                format!("Directory not found: {}", dir_path.display()),
            ));
        }

        if !dir_path.is_dir() {
            return Err(Error::tool(
                "ls",
                format!("Path is not a directory: {}", dir_path.display()),
            ));
        }

        let mut entries: Vec<(String, bool, u64)> = Vec::new();

        let mut read_dir = tokio::fs::read_dir(&dir_path)
            .await
            .map_err(|e| Error::tool("ls", format!("Failed to read directory: {e}")))?;

        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| Error::tool("ls", format!("Failed to read entry: {e}")))?
        {
            let name = entry.file_name().to_string_lossy().to_string();
            let metadata = entry.metadata().await.ok();
            let is_dir = metadata.as_ref().is_some_and(std::fs::Metadata::is_dir);
            let size = metadata.as_ref().map_or(0, std::fs::Metadata::len);

            entries.push((name, is_dir, size));
        }

        // Sort: directories first, then by name
        entries.sort_by(|a, b| match (a.1, b.1) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
        });

        let total_entries = entries.len();
        let entries: Vec<_> = entries.into_iter().take(limit).collect();

        // Format output
        let output: Vec<String> = entries
            .iter()
            .map(|(name, is_dir, size)| {
                if *is_dir {
                    format!("{name}/")
                } else {
                    format!("{:>8}  {name}", format_size(*size))
                }
            })
            .collect();

        let result = if output.is_empty() {
            "(empty directory)".to_string()
        } else {
            output.join("\n")
        };

        Ok(ToolOutput {
            content: vec![ContentBlock::Text(TextContent::new(result))],
            details: Some(serde_json::json!({
                "path": dir_path.display().to_string(),
                "totalEntries": total_entries,
                "shownEntries": entries.len(),
                "limit": limit,
            })),
        })
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_head() {
        let content = "line1\nline2\nline3\nline4\nline5";
        let result = truncate_head(content, 3, 1000);

        assert_eq!(result.content, "line1\nline2\nline3");
        assert!(result.truncated);
        assert_eq!(result.truncated_by, Some(TruncatedBy::Lines));
        assert_eq!(result.total_lines, 5);
        assert_eq!(result.output_lines, 3);
    }

    #[test]
    fn test_truncate_tail() {
        let content = "line1\nline2\nline3\nline4\nline5";
        let result = truncate_tail(content, 3, 1000);

        assert_eq!(result.content, "line3\nline4\nline5");
        assert!(result.truncated);
        assert_eq!(result.truncated_by, Some(TruncatedBy::Lines));
        assert_eq!(result.total_lines, 5);
        assert_eq!(result.output_lines, 3);
    }

    #[test]
    fn test_truncate_by_bytes() {
        let content = "short\nthis is a longer line\nanother";
        let result = truncate_head(content, 100, 15);

        assert!(result.truncated);
        assert_eq!(result.truncated_by, Some(TruncatedBy::Bytes));
    }

    #[test]
    fn test_resolve_path_absolute() {
        let cwd = PathBuf::from("/home/user/project");
        let result = resolve_path("/absolute/path", &cwd);
        assert_eq!(result, PathBuf::from("/absolute/path"));
    }

    #[test]
    fn test_resolve_path_relative() {
        let cwd = PathBuf::from("/home/user/project");
        let result = resolve_path("src/main.rs", &cwd);
        assert_eq!(result, PathBuf::from("/home/user/project/src/main.rs"));
    }

    #[test]
    fn test_is_image_file() {
        assert!(is_image_file(Path::new("image.png")));
        assert!(is_image_file(Path::new("photo.JPG")));
        assert!(!is_image_file(Path::new("code.rs")));
        assert!(!is_image_file(Path::new("no_extension")));
    }

    #[test]
    fn test_format_size() {
        assert_eq!(format_size(500), "500B");
        assert_eq!(format_size(1024), "1.0K");
        assert_eq!(format_size(1536), "1.5K");
        assert_eq!(format_size(1_048_576), "1.0M");
        assert_eq!(format_size(1_073_741_824), "1.0G");
    }

    #[test]
    fn test_add_line_numbers() {
        let content = "first\nsecond\nthird";
        let result = add_line_numbers(content, 10);
        assert!(result.contains("10\tfirst"));
        assert!(result.contains("11\tsecond"));
        assert!(result.contains("12\tthird"));
    }

    #[test]
    fn test_truncate_line() {
        let short = "short line";
        let result = truncate_line(short, 100);
        assert_eq!(result.text, "short line");
        assert!(!result.was_truncated);

        let long = "a".repeat(600);
        let result = truncate_line(&long, 500);
        assert!(result.was_truncated);
        assert!(result.text.ends_with("... [truncated]"));
    }
}
