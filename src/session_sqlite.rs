use crate::error::{Error, Result};
use crate::session::{SessionEntry, SessionHeader};
use crate::session_metrics;
use std::path::Path;

const INIT_SQL: &str = r"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pi_session_header (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pi_session_entries (
  seq INTEGER PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pi_session_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
";

#[derive(Debug, Clone)]
pub struct SqliteSessionMeta {
    pub header: SessionHeader,
    pub message_count: u64,
    pub name: Option<String>,
}

fn compute_message_count_and_name(entries: &[SessionEntry]) -> (u64, Option<String>) {
    let mut message_count = 0u64;
    let mut name = None;

    for entry in entries {
        match entry {
            SessionEntry::Message(_) => message_count += 1,
            SessionEntry::SessionInfo(info) => {
                if info.name.is_some() {
                    name.clone_from(&info.name);
                }
            }
            _ => {}
        }
    }

    (message_count, name)
}

pub async fn load_session(path: &Path) -> Result<(SessionHeader, Vec<SessionEntry>)> {
    let metrics = session_metrics::global();
    let _timer = metrics.start_timer(&metrics.sqlite_load);

    if !path.exists() {
        return Err(Error::SessionNotFound {
            path: path.display().to_string(),
        });
    }

    let path = path.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&path)
            .map_err(|e| Error::session(format!("Failed to open SQLite session: {e}")))?;

        // Load header
        let header_json: String = conn
            .query_row("SELECT json FROM pi_session_header LIMIT 1", [], |row| {
                row.get(0)
            })
            .map_err(|e| Error::session(format!("Failed to load session header: {e}")))?;

        let header: SessionHeader = serde_json::from_str(&header_json)?;

        // Load entries
        let mut stmt = conn
            .prepare("SELECT json FROM pi_session_entries ORDER BY seq ASC")
            .map_err(|e| Error::session(format!("Failed to prepare query: {e}")))?;

        let entries = stmt
            .query_map([], |row| {
                let json: String = row.get(0)?;
                Ok(json)
            })
            .map_err(|e| Error::session(format!("Failed to query entries: {e}")))?
            .collect::<std::result::Result<Vec<String>, rusqlite::Error>>()
            .map_err(|e| Error::session(format!("Failed to read entries: {e}")))?
            .into_iter()
            .map(|json| serde_json::from_str(&json))
            .collect::<std::result::Result<Vec<SessionEntry>, serde_json::Error>>()?;

        Ok::<_, Error>((header, entries))
    })
    .await
    .map_err(|e| Error::session(format!("Task join error: {e}")))??;

    Ok(result)
}

pub async fn load_session_meta(path: &Path) -> Result<SqliteSessionMeta> {
    let metrics = session_metrics::global();
    let _timer = metrics.start_timer(&metrics.sqlite_load_meta);

    if !path.exists() {
        return Err(Error::SessionNotFound {
            path: path.display().to_string(),
        });
    }

    let path = path.to_path_buf();
    let result = tokio::task::spawn_blocking(move || load_session_meta_sync(&path))
        .await
        .map_err(|e| Error::session(format!("Task join error: {e}")))??;

    Ok(result)
}

/// Synchronous version of [`load_session_meta`] for use on non-Tokio threads
/// (e.g. the session-scan std::thread).
pub fn load_session_meta_sync(path: &Path) -> Result<SqliteSessionMeta> {
    if !path.exists() {
        return Err(Error::SessionNotFound {
            path: path.display().to_string(),
        });
    }

    let conn = rusqlite::Connection::open(path)
        .map_err(|e| Error::session(format!("Failed to open SQLite session: {e}")))?;

    // Load header
    let header_json: String = conn
        .query_row("SELECT json FROM pi_session_header LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(|e| Error::session(format!("Failed to load session header: {e}")))?;

    let header: SessionHeader = serde_json::from_str(&header_json)?;

    // Load meta
    let mut stmt = conn
        .prepare("SELECT key,value FROM pi_session_meta WHERE key IN ('message_count','name')")
        .map_err(|e| Error::session(format!("Failed to prepare meta query: {e}")))?;

    let meta_rows = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })
        .map_err(|e| Error::session(format!("Failed to query meta: {e}")))?
        .collect::<std::result::Result<Vec<(String, String)>, rusqlite::Error>>()
        .map_err(|e| Error::session(format!("Failed to read meta: {e}")))?;

    let mut message_count: Option<u64> = None;
    let mut name: Option<String> = None;
    for (key, value) in meta_rows {
        match key.as_str() {
            "message_count" => message_count = value.parse::<u64>().ok(),
            "name" => name = Some(value),
            _ => {}
        }
    }

    // If message_count not in meta, compute from entries
    let message_count = if let Some(count) = message_count {
        count
    } else {
        let mut stmt = conn
            .prepare("SELECT json FROM pi_session_entries ORDER BY seq ASC")
            .map_err(|e| Error::session(format!("Failed to prepare entries query: {e}")))?;

        let entries = stmt
            .query_map([], |row| {
                let json: String = row.get(0)?;
                Ok(json)
            })
            .map_err(|e| Error::session(format!("Failed to query entries: {e}")))?
            .collect::<std::result::Result<Vec<String>, rusqlite::Error>>()
            .map_err(|e| Error::session(format!("Failed to read entries: {e}")))?
            .into_iter()
            .map(|json| serde_json::from_str(&json))
            .collect::<std::result::Result<Vec<SessionEntry>, serde_json::Error>>()?;

        let (message_count, fallback_name) = compute_message_count_and_name(&entries);
        if name.is_none() {
            name = fallback_name;
        }
        message_count
    };

    Ok(SqliteSessionMeta {
        header,
        message_count,
        name,
    })
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;
    use crate::model::UserContent;
    use crate::session::{EntryBase, MessageEntry, SessionInfoEntry, SessionMessage};

    fn dummy_base() -> EntryBase {
        EntryBase {
            id: Some("test-id".to_string()),
            parent_id: None,
            timestamp: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    fn message_entry() -> SessionEntry {
        SessionEntry::Message(MessageEntry {
            base: dummy_base(),
            message: SessionMessage::User {
                content: UserContent::Text("hello".to_string()),
                timestamp: None,
            },
        })
    }

    fn session_info_entry(name: Option<String>) -> SessionEntry {
        SessionEntry::SessionInfo(SessionInfoEntry {
            base: dummy_base(),
            name,
        })
    }

    #[test]
    fn compute_counts_empty() {
        let (count, name) = compute_message_count_and_name(&[]);
        assert_eq!(count, 0);
        assert!(name.is_none());
    }

    #[test]
    fn compute_counts_messages_only() {
        let entries = vec![message_entry(), message_entry(), message_entry()];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 3);
        assert!(name.is_none());
    }

    #[test]
    fn compute_counts_session_info_with_name() {
        let entries = vec![
            message_entry(),
            session_info_entry(Some("My Session".to_string())),
            message_entry(),
        ];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 2);
        assert_eq!(name, Some("My Session".to_string()));
    }

    #[test]
    fn compute_counts_session_info_none_name_ignored() {
        let entries = vec![
            session_info_entry(Some("First".to_string())),
            session_info_entry(None),
            message_entry(),
        ];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 1);
        // The second SessionInfo has name=None, so it doesn't overwrite.
        assert_eq!(name, Some("First".to_string()));
    }

    #[test]
    fn compute_counts_latest_name_wins() {
        let entries = vec![
            session_info_entry(Some("First".to_string())),
            session_info_entry(Some("Second".to_string())),
        ];
        let (_, name) = compute_message_count_and_name(&entries);
        assert_eq!(name, Some("Second".to_string()));
    }

    // -- Non-message / non-session-info entries are ignored --

    #[test]
    fn compute_counts_ignores_model_change_entries() {
        use crate::session::ModelChangeEntry;
        let entries = vec![
            message_entry(),
            SessionEntry::ModelChange(ModelChangeEntry {
                base: dummy_base(),
                provider: "anthropic".to_string(),
                model_id: "claude-sonnet-4-5".to_string(),
            }),
            message_entry(),
        ];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 2);
        assert!(name.is_none());
    }

    #[test]
    fn compute_counts_ignores_label_entries() {
        use crate::session::LabelEntry;
        let entries = vec![
            message_entry(),
            SessionEntry::Label(LabelEntry {
                base: dummy_base(),
                target_id: "some-id".to_string(),
                label: Some("important".to_string()),
            }),
        ];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 1);
        assert!(name.is_none());
    }

    #[test]
    fn compute_counts_ignores_custom_entries() {
        use crate::session::CustomEntry;
        let entries = vec![
            SessionEntry::Custom(CustomEntry {
                base: dummy_base(),
                custom_type: "my_custom".to_string(),
                data: Some(serde_json::json!({"key": "value"})),
            }),
            message_entry(),
        ];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 1);
        assert!(name.is_none());
    }

    #[test]
    fn compute_counts_ignores_compaction_entries() {
        use crate::session::CompactionEntry;
        let entries = vec![
            message_entry(),
            SessionEntry::Compaction(CompactionEntry {
                base: dummy_base(),
                summary: "summary text".to_string(),
                first_kept_entry_id: "e1".to_string(),
                tokens_before: 500,
                details: None,
                from_hook: None,
            }),
            message_entry(),
            message_entry(),
        ];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 3);
        assert!(name.is_none());
    }

    #[test]
    fn compute_counts_mixed_entry_types() {
        use crate::session::{CompactionEntry, CustomEntry, LabelEntry, ModelChangeEntry};
        let entries = vec![
            message_entry(),
            SessionEntry::ModelChange(ModelChangeEntry {
                base: dummy_base(),
                provider: "openai".to_string(),
                model_id: "gpt-4".to_string(),
            }),
            session_info_entry(Some("Named".to_string())),
            SessionEntry::Label(LabelEntry {
                base: dummy_base(),
                target_id: "t1".to_string(),
                label: None,
            }),
            message_entry(),
            SessionEntry::Compaction(CompactionEntry {
                base: dummy_base(),
                summary: "s".to_string(),
                first_kept_entry_id: "e1".to_string(),
                tokens_before: 100,
                details: None,
                from_hook: None,
            }),
            SessionEntry::Custom(CustomEntry {
                base: dummy_base(),
                custom_type: "ct".to_string(),
                data: None,
            }),
            message_entry(),
        ];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 3);
        assert_eq!(name, Some("Named".to_string()));
    }

    // -- SqliteSessionMeta struct --

    #[test]
    fn sqlite_session_meta_fields() {
        let meta = SqliteSessionMeta {
            header: SessionHeader {
                id: "test-session".to_string(),
                ..SessionHeader::default()
            },
            message_count: 42,
            name: Some("My Session".to_string()),
        };
        assert_eq!(meta.header.id, "test-session");
        assert_eq!(meta.message_count, 42);
        assert_eq!(meta.name.as_deref(), Some("My Session"));
    }

    #[test]
    fn sqlite_session_meta_no_name() {
        let meta = SqliteSessionMeta {
            header: SessionHeader::default(),
            message_count: 0,
            name: None,
        };
        assert_eq!(meta.message_count, 0);
        assert!(meta.name.is_none());
    }

    // -- compute_message_count_and_name: large input --

    #[test]
    fn compute_counts_large_message_set() {
        let entries: Vec<SessionEntry> = (0..1000).map(|_| message_entry()).collect();
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 1000);
        assert!(name.is_none());
    }

    // -- compute_message_count_and_name: name then messages only --

    #[test]
    fn compute_counts_name_set_early_persists() {
        let entries = vec![
            session_info_entry(Some("Early Name".to_string())),
            message_entry(),
            message_entry(),
            message_entry(),
        ];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 3);
        assert_eq!(name, Some("Early Name".to_string()));
    }

    // -- compute_message_count_and_name: branch summary entry --

    #[test]
    fn compute_counts_ignores_branch_summary() {
        use crate::session::BranchSummaryEntry;
        let entries = vec![
            message_entry(),
            SessionEntry::BranchSummary(BranchSummaryEntry {
                base: dummy_base(),
                from_id: "parent-id".to_string(),
                summary: "branch summary".to_string(),
                details: None,
                from_hook: None,
            }),
        ];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 1);
        assert!(name.is_none());
    }

    // -- compute_message_count_and_name: thinking level change --

    #[test]
    fn compute_counts_ignores_thinking_level_change() {
        use crate::session::ThinkingLevelChangeEntry;
        let entries = vec![
            SessionEntry::ThinkingLevelChange(ThinkingLevelChangeEntry {
                base: dummy_base(),
                thinking_level: "high".to_string(),
            }),
            message_entry(),
        ];
        let (count, name) = compute_message_count_and_name(&entries);
        assert_eq!(count, 1);
        assert!(name.is_none());
    }
}

pub async fn save_session(
    path: &Path,
    header: &SessionHeader,
    entries: &[SessionEntry],
) -> Result<()> {
    let metrics = session_metrics::global();
    let _save_timer = metrics.start_timer(&metrics.sqlite_save);

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    // Serialize header + entries and track serialization time + bytes.
    let serialize_timer = metrics.start_timer(&metrics.sqlite_serialize);
    let header_json = serde_json::to_string(header)?;
    let mut total_json_bytes = header_json.len() as u64;

    let mut entry_jsons = Vec::with_capacity(entries.len());
    for entry in entries {
        let json = serde_json::to_string(entry)?;
        total_json_bytes += json.len() as u64;
        entry_jsons.push(json);
    }
    serialize_timer.finish();
    metrics.record_bytes(&metrics.sqlite_bytes, total_json_bytes);

    let (message_count, name) = compute_message_count_and_name(entries);
    let header_id = header.id.clone();
    let path = path.to_path_buf();

    tokio::task::spawn_blocking(move || {
        let mut conn = rusqlite::Connection::open(&path)
            .map_err(|e| Error::session(format!("Failed to open SQLite session: {e}")))?;

        conn.execute_batch(INIT_SQL)
            .map_err(|e| Error::session(format!("Failed to initialize database: {e}")))?;

        let tx = conn
            .transaction()
            .map_err(|e| Error::session(format!("Failed to begin transaction: {e}")))?;

        tx.execute("DELETE FROM pi_session_entries", [])
            .map_err(|e| Error::session(format!("Failed to delete entries: {e}")))?;
        tx.execute("DELETE FROM pi_session_header", [])
            .map_err(|e| Error::session(format!("Failed to delete header: {e}")))?;
        tx.execute("DELETE FROM pi_session_meta", [])
            .map_err(|e| Error::session(format!("Failed to delete meta: {e}")))?;

        tx.execute(
            "INSERT INTO pi_session_header (id,json) VALUES (?1,?2)",
            rusqlite::params![header_id, header_json],
        )
        .map_err(|e| Error::session(format!("Failed to insert header: {e}")))?;

        for (idx, json) in entry_jsons.into_iter().enumerate() {
            let seq = i64::try_from(idx + 1).unwrap_or(i64::MAX);
            tx.execute(
                "INSERT INTO pi_session_entries (seq,json) VALUES (?1,?2)",
                rusqlite::params![seq, json],
            )
            .map_err(|e| Error::session(format!("Failed to insert entry: {e}")))?;
        }

        tx.execute(
            "INSERT INTO pi_session_meta (key,value) VALUES (?1,?2)",
            rusqlite::params!["message_count", message_count.to_string()],
        )
        .map_err(|e| Error::session(format!("Failed to insert message_count: {e}")))?;

        if let Some(name) = name {
            tx.execute(
                "INSERT INTO pi_session_meta (key,value) VALUES (?1,?2)",
                rusqlite::params!["name", name],
            )
            .map_err(|e| Error::session(format!("Failed to insert name: {e}")))?;
        }

        tx.commit()
            .map_err(|e| Error::session(format!("Failed to commit transaction: {e}")))?;

        Ok::<_, Error>(())
    })
    .await
    .map_err(|e| Error::session(format!("Task join error: {e}")))??;

    Ok(())
}

/// Incrementally append new entries to an existing SQLite session database.
///
/// Only the entries in `new_entries` (starting at 1-based sequence `start_seq`)
/// are inserted. The header row is left unchanged, while the `message_count`
/// and `name` meta rows are upserted to reflect the current totals.
///
/// This avoids the DELETE+reinsert cost of [`save_session`] for the common
/// case where a few entries are appended between saves.
pub async fn append_entries(
    path: &Path,
    new_entries: &[SessionEntry],
    start_seq: usize,
    message_count: u64,
    session_name: Option<&str>,
) -> Result<()> {
    let metrics = session_metrics::global();
    let _timer = metrics.start_timer(&metrics.sqlite_append);

    // Serialize and insert only the new entries.
    let serialize_timer = metrics.start_timer(&metrics.sqlite_serialize);
    let mut total_json_bytes = 0u64;
    let mut entry_jsons = Vec::with_capacity(new_entries.len());
    for entry in new_entries {
        let json = serde_json::to_string(entry)?;
        total_json_bytes += json.len() as u64;
        entry_jsons.push(json);
    }
    serialize_timer.finish();
    metrics.record_bytes(&metrics.sqlite_bytes, total_json_bytes);

    let path = path.to_path_buf();
    let session_name = session_name.map(String::from);

    tokio::task::spawn_blocking(move || {
        let mut conn = rusqlite::Connection::open(&path)
            .map_err(|e| Error::session(format!("Failed to open SQLite session: {e}")))?;

        // Ensure WAL mode is active (no-op if already set).
        conn.execute_batch("PRAGMA journal_mode = WAL")
            .map_err(|e| Error::session(format!("Failed to set WAL mode: {e}")))?;

        let tx = conn
            .transaction()
            .map_err(|e| Error::session(format!("Failed to begin transaction: {e}")))?;

        for (i, json) in entry_jsons.into_iter().enumerate() {
            let seq = i64::try_from(start_seq + i + 1).unwrap_or(i64::MAX);
            tx.execute(
                "INSERT INTO pi_session_entries (seq,json) VALUES (?1,?2)",
                rusqlite::params![seq, json],
            )
            .map_err(|e| Error::session(format!("Failed to insert entry: {e}")))?;
        }

        // Upsert meta counters (INSERT OR REPLACE).
        tx.execute(
            "INSERT OR REPLACE INTO pi_session_meta (key,value) VALUES (?1,?2)",
            rusqlite::params!["message_count", message_count.to_string()],
        )
        .map_err(|e| Error::session(format!("Failed to upsert message_count: {e}")))?;

        if let Some(name) = session_name {
            tx.execute(
                "INSERT OR REPLACE INTO pi_session_meta (key,value) VALUES (?1,?2)",
                rusqlite::params!["name", name],
            )
            .map_err(|e| Error::session(format!("Failed to upsert name: {e}")))?;
        }

        tx.commit()
            .map_err(|e| Error::session(format!("Failed to commit transaction: {e}")))?;

        Ok::<_, Error>(())
    })
    .await
    .map_err(|e| Error::session(format!("Task join error: {e}")))??;

    Ok(())
}
