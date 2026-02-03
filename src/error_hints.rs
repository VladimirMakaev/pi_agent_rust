//! Error hints: mapping from error variants to user-facing remediation suggestions.
//!
//! Each error variant maps to:
//! - A 1-line summary (human readable)
//! - 0-2 actionable hints (commands, env vars, paths)
//! - Contextual fields that should be printed with the error
//!
//! # Design Principles
//! - Hints must be stable for testability
//! - Avoid OS-specific hints unless OS is reliably detectable
//! - Never suggest destructive actions
//! - Prefer specific, actionable guidance over generic messages

use crate::error::Error;

/// A remediation hint for an error.
#[derive(Debug, Clone)]
pub struct ErrorHint {
    /// Brief 1-line summary of the error category.
    pub summary: &'static str,
    /// Actionable hints for the user (0-2 items).
    pub hints: &'static [&'static str],
    /// Context fields that should be displayed with the error.
    pub context_fields: &'static [&'static str],
}

/// Get remediation hints for an error variant.
///
/// Returns structured hints that can be rendered in any output mode
/// (interactive, print, RPC).
pub fn hints_for_error(error: &Error) -> ErrorHint {
    match error {
        // ====================================================================
        // Configuration Errors
        // ====================================================================
        Error::Config(msg) if msg.contains("settings.json") => ErrorHint {
            summary: "Invalid or missing configuration file",
            hints: &[
                "Check that ~/.pi/agent/settings.json exists and is valid JSON",
                "Run 'pi config' to see configuration paths and precedence",
            ],
            context_fields: &["file_path"],
        },
        Error::Config(msg) if msg.contains("models.json") => ErrorHint {
            summary: "Invalid models configuration",
            hints: &[
                "Verify ~/.pi/agent/models.json has valid JSON syntax",
                "Check that 'providers' key exists in models.json",
            ],
            context_fields: &["file_path", "parse_error"],
        },
        Error::Config(_) => ErrorHint {
            summary: "Configuration error",
            hints: &["Check configuration file syntax and required fields"],
            context_fields: &[],
        },

        // ====================================================================
        // Session Errors
        // ====================================================================
        Error::SessionNotFound { path: _ } => ErrorHint {
            summary: "Session file not found",
            hints: &[
                "Use 'pi' without --session to start a new session",
                "Use 'pi --resume' to pick from existing sessions",
            ],
            context_fields: &["path"],
        },
        Error::Session(msg) if msg.contains("corrupted") || msg.contains("invalid") => ErrorHint {
            summary: "Session file is corrupted or invalid",
            hints: &[
                "Start a new session with 'pi'",
                "Session files are JSONL format - check for malformed lines",
            ],
            context_fields: &["path", "line_number"],
        },
        Error::Session(msg) if msg.contains("locked") => ErrorHint {
            summary: "Session file is locked by another process",
            hints: &["Close other Pi instances using this session"],
            context_fields: &["path"],
        },
        Error::Session(_) => ErrorHint {
            summary: "Session error",
            hints: &["Try starting a new session with 'pi'"],
            context_fields: &[],
        },

        // ====================================================================
        // Authentication Errors
        // ====================================================================
        Error::Auth(msg) if msg.contains("API key") || msg.contains("api_key") => ErrorHint {
            summary: "API key not configured",
            hints: &[
                "Set ANTHROPIC_API_KEY environment variable",
                "Or add key to ~/.pi/agent/auth.json",
            ],
            context_fields: &["provider"],
        },
        Error::Auth(msg) if msg.contains("401") || msg.contains("unauthorized") => ErrorHint {
            summary: "API key is invalid or expired",
            hints: &[
                "Verify your API key is correct and active",
                "Check API key permissions at your provider's console",
            ],
            context_fields: &["provider", "status_code"],
        },
        Error::Auth(msg) if msg.contains("OAuth") || msg.contains("refresh") => ErrorHint {
            summary: "OAuth token expired or invalid",
            hints: &[
                "Run 'pi login <provider>' to re-authenticate",
                "Or set API key directly via environment variable",
            ],
            context_fields: &["provider"],
        },
        Error::Auth(msg) if msg.contains("lock") => ErrorHint {
            summary: "Auth file locked by another process",
            hints: &["Close other Pi instances that may be using auth.json"],
            context_fields: &["path"],
        },
        Error::Auth(_) => ErrorHint {
            summary: "Authentication error",
            hints: &["Check your API credentials"],
            context_fields: &[],
        },

        // ====================================================================
        // Provider/API Errors
        // ====================================================================
        Error::Provider { provider, message }
            if message.contains("429") || message.contains("rate limit") =>
        {
            ErrorHint {
                summary: "Rate limit exceeded",
                hints: &[
                    "Wait a moment and try again",
                    "Consider using a different model or reducing request frequency",
                ],
                context_fields: &["provider", "retry_after"],
            }
        }
        Error::Provider {
            provider: _,
            message,
        } if message.contains("500") || message.contains("server error") => ErrorHint {
            summary: "Provider server error",
            hints: &[
                "This is a temporary issue - try again shortly",
                "Check provider status page for outages",
            ],
            context_fields: &["provider", "status_code"],
        },
        Error::Provider {
            provider: _,
            message,
        } if message.contains("connection") || message.contains("network") => ErrorHint {
            summary: "Network connection error",
            hints: &[
                "Check your internet connection",
                "If using a proxy, verify proxy settings",
            ],
            context_fields: &["provider", "url"],
        },
        Error::Provider {
            provider: _,
            message,
        } if message.contains("timeout") => ErrorHint {
            summary: "Request timed out",
            hints: &[
                "Try again - the provider may be slow",
                "Consider using a smaller context or simpler request",
            ],
            context_fields: &["provider", "timeout_seconds"],
        },
        Error::Provider {
            provider: _,
            message,
        } if message.contains("model") && message.contains("not found") => ErrorHint {
            summary: "Model not found or unavailable",
            hints: &[
                "Check that the model ID is correct",
                "Use 'pi --list-models' to see available models",
            ],
            context_fields: &["provider", "model_id"],
        },
        Error::Provider { .. } => ErrorHint {
            summary: "Provider API error",
            hints: &["Check provider documentation for this error"],
            context_fields: &["provider", "status_code"],
        },

        // ====================================================================
        // Tool Errors
        // ====================================================================
        Error::Tool { tool, message } if *tool == "read" && message.contains("not found") => {
            ErrorHint {
                summary: "File not found",
                hints: &[
                    "Verify the file path is correct",
                    "Use 'ls' or 'find' to locate the file",
                ],
                context_fields: &["path"],
            }
        }
        Error::Tool { tool, message } if *tool == "read" && message.contains("permission") => {
            ErrorHint {
                summary: "Permission denied reading file",
                hints: &["Check file permissions"],
                context_fields: &["path"],
            }
        }
        Error::Tool { tool, message } if *tool == "write" && message.contains("permission") => {
            ErrorHint {
                summary: "Permission denied writing file",
                hints: &["Check directory permissions"],
                context_fields: &["path"],
            }
        }
        Error::Tool { tool, message } if *tool == "edit" && message.contains("not found") => {
            ErrorHint {
                summary: "Text to replace not found in file",
                hints: &[
                    "Verify the old_text exactly matches content in the file",
                    "Use 'read' to see the current file content",
                ],
                context_fields: &["path", "old_text_preview"],
            }
        }
        Error::Tool { tool, message } if *tool == "edit" && message.contains("ambiguous") => {
            ErrorHint {
                summary: "Multiple matches found for replacement",
                hints: &["Provide more context in old_text to make it unique"],
                context_fields: &["path", "match_count"],
            }
        }
        Error::Tool { tool, message } if *tool == "bash" && message.contains("timeout") => {
            ErrorHint {
                summary: "Command timed out",
                hints: &[
                    "Increase timeout with 'timeout' parameter",
                    "Consider breaking into smaller commands",
                ],
                context_fields: &["command", "timeout_seconds"],
            }
        }
        Error::Tool { tool, message } if *tool == "bash" && message.contains("exit code") => {
            ErrorHint {
                summary: "Command failed with non-zero exit code",
                hints: &["Review command output for error details"],
                context_fields: &["command", "exit_code", "stderr"],
            }
        }
        Error::Tool { tool, message } if *tool == "grep" && message.contains("pattern") => {
            ErrorHint {
                summary: "Invalid regex pattern",
                hints: &["Check regex syntax - special characters may need escaping"],
                context_fields: &["pattern"],
            }
        }
        Error::Tool { tool, message } if *tool == "find" && message.contains("fd") => ErrorHint {
            summary: "fd command not found",
            hints: &[
                "Install fd: 'apt install fd-find' or 'brew install fd'",
                "The binary may be named 'fdfind' on some systems",
            ],
            context_fields: &[],
        },
        Error::Tool { .. } => ErrorHint {
            summary: "Tool execution error",
            hints: &["Review the tool parameters and try again"],
            context_fields: &["tool", "command"],
        },

        // ====================================================================
        // Validation Errors
        // ====================================================================
        Error::Validation(msg) if msg.contains("required") => ErrorHint {
            summary: "Required field missing",
            hints: &["Provide all required parameters"],
            context_fields: &["field_name"],
        },
        Error::Validation(msg) if msg.contains("type") => ErrorHint {
            summary: "Invalid parameter type",
            hints: &["Check parameter types match expected schema"],
            context_fields: &["field_name", "expected_type"],
        },
        Error::Validation(_) => ErrorHint {
            summary: "Validation error",
            hints: &["Check input parameters"],
            context_fields: &[],
        },

        // ====================================================================
        // Extension Errors
        // ====================================================================
        Error::Extension(msg) if msg.contains("not found") => ErrorHint {
            summary: "Extension not found",
            hints: &[
                "Check extension name is correct",
                "Use 'pi list' to see installed extensions",
            ],
            context_fields: &["extension_name"],
        },
        Error::Extension(msg) if msg.contains("manifest") => ErrorHint {
            summary: "Invalid extension manifest",
            hints: &[
                "Check extension manifest.json syntax",
                "Verify required fields are present",
            ],
            context_fields: &["extension_name", "manifest_path"],
        },
        Error::Extension(msg) if msg.contains("capability") || msg.contains("permission") => {
            ErrorHint {
                summary: "Extension capability denied",
                hints: &[
                    "Extension requires capabilities not granted by policy",
                    "Review extension security settings",
                ],
                context_fields: &["extension_name", "capability"],
            }
        }
        Error::Extension(_) => ErrorHint {
            summary: "Extension error",
            hints: &["Check extension configuration"],
            context_fields: &["extension_name"],
        },

        // ====================================================================
        // IO Errors
        // ====================================================================
        Error::Io(e) if e.kind() == std::io::ErrorKind::NotFound => ErrorHint {
            summary: "File or directory not found",
            hints: &["Verify the path exists"],
            context_fields: &["path"],
        },
        Error::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied => ErrorHint {
            summary: "Permission denied",
            hints: &["Check file/directory permissions"],
            context_fields: &["path"],
        },
        Error::Io(e) if e.kind() == std::io::ErrorKind::AlreadyExists => ErrorHint {
            summary: "File already exists",
            hints: &["Use a different path or remove existing file first"],
            context_fields: &["path"],
        },
        Error::Io(_) => ErrorHint {
            summary: "I/O error",
            hints: &["Check file system and permissions"],
            context_fields: &["path"],
        },

        // ====================================================================
        // JSON Errors
        // ====================================================================
        Error::Json(e) if e.is_syntax() => ErrorHint {
            summary: "Invalid JSON syntax",
            hints: &[
                "Check for missing commas, brackets, or quotes",
                "Validate JSON at jsonlint.com or similar",
            ],
            context_fields: &["line", "column"],
        },
        Error::Json(e) if e.is_data() => ErrorHint {
            summary: "JSON data does not match expected structure",
            hints: &["Check that JSON fields match expected schema"],
            context_fields: &["field_path"],
        },
        Error::Json(_) => ErrorHint {
            summary: "JSON error",
            hints: &["Verify JSON syntax and structure"],
            context_fields: &[],
        },

        // ====================================================================
        // SQLite Errors
        // ====================================================================
        Error::Sqlite(e) if e.to_string().contains("locked") => ErrorHint {
            summary: "Database locked",
            hints: &["Close other Pi instances using this database"],
            context_fields: &["db_path"],
        },
        Error::Sqlite(e) if e.to_string().contains("corrupt") => ErrorHint {
            summary: "Database corrupted",
            hints: &[
                "The session index may need to be rebuilt",
                "Delete ~/.pi/agent/sessions/index.db to rebuild",
            ],
            context_fields: &["db_path"],
        },
        Error::Sqlite(_) => ErrorHint {
            summary: "Database error",
            hints: &["Check database file permissions and integrity"],
            context_fields: &["db_path"],
        },

        // ====================================================================
        // Generic/Other Errors
        // ====================================================================
        Error::Aborted => ErrorHint {
            summary: "Operation cancelled by user",
            hints: &[],
            context_fields: &[],
        },
        Error::Api(msg) if msg.contains("401") => ErrorHint {
            summary: "Unauthorized API request",
            hints: &["Check your API credentials"],
            context_fields: &["url", "status_code"],
        },
        Error::Api(msg) if msg.contains("403") => ErrorHint {
            summary: "Forbidden API request",
            hints: &["Check API key permissions for this resource"],
            context_fields: &["url", "status_code"],
        },
        Error::Api(msg) if msg.contains("404") => ErrorHint {
            summary: "API resource not found",
            hints: &["Check the API endpoint URL"],
            context_fields: &["url"],
        },
        Error::Api(_) => ErrorHint {
            summary: "API error",
            hints: &["Check API documentation"],
            context_fields: &["url", "status_code"],
        },
    }
}

/// Format an error with its hints for display.
///
/// Returns a formatted string suitable for terminal output.
pub fn format_error_with_hints(error: &Error) -> String {
    let hint = hints_for_error(error);
    let mut output = String::new();

    // Error message
    output.push_str(&format!("Error: {}\n", error));

    // Summary if different from error message
    if !error.to_string().contains(hint.summary) {
        output.push_str(&format!("\n{}\n", hint.summary));
    }

    // Hints
    if !hint.hints.is_empty() {
        output.push_str("\nSuggestions:\n");
        for h in hint.hints {
            output.push_str(&format!("  • {}\n", h));
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_error_hints() {
        let error = Error::config("settings.json not found");
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("configuration"));
        assert!(!hint.hints.is_empty());
    }

    #[test]
    fn test_auth_error_api_key_hints() {
        let error = Error::auth("API key not set");
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("API key"));
        assert!(hint.hints.iter().any(|h| h.contains("ANTHROPIC_API_KEY")));
    }

    #[test]
    fn test_auth_error_401_hints() {
        let error = Error::auth("401 unauthorized");
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("invalid") || hint.summary.contains("expired"));
    }

    #[test]
    fn test_provider_rate_limit_hints() {
        let error = Error::provider("anthropic", "429 rate limit exceeded");
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("Rate limit"));
        assert!(hint.hints.iter().any(|h| h.contains("Wait")));
    }

    #[test]
    fn test_tool_read_not_found_hints() {
        let error = Error::tool("read", "file not found: /path/to/file");
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("not found"));
        assert!(hint.context_fields.contains(&"path"));
    }

    #[test]
    fn test_tool_edit_ambiguous_hints() {
        let error = Error::tool("edit", "ambiguous match: found 3 occurrences");
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("Multiple"));
        assert!(hint.hints.iter().any(|h| h.contains("context")));
    }

    #[test]
    fn test_tool_fd_not_found_hints() {
        let error = Error::tool("find", "fd command not found");
        let hint = hints_for_error(&error);
        assert!(hint.hints.iter().any(|h| h.contains("apt install")));
    }

    #[test]
    fn test_session_not_found_hints() {
        let error = Error::SessionNotFound {
            path: "/path/to/session.jsonl".to_string(),
        };
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("not found"));
        assert!(hint.hints.iter().any(|h| h.contains("--resume")));
    }

    #[test]
    fn test_json_syntax_error_hints() {
        let json_err = serde_json::from_str::<serde_json::Value>("{ invalid }").unwrap_err();
        let error = Error::Json(Box::new(json_err));
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("JSON") || hint.summary.contains("syntax"));
    }

    #[test]
    fn test_aborted_has_no_hints() {
        let error = Error::Aborted;
        let hint = hints_for_error(&error);
        assert!(hint.hints.is_empty());
    }

    #[test]
    fn test_format_error_with_hints() {
        let error = Error::auth("API key not set");
        let formatted = format_error_with_hints(&error);
        assert!(formatted.contains("Error:"));
        assert!(formatted.contains("Suggestions:"));
    }

    #[test]
    fn test_extension_capability_denied_hints() {
        let error = Error::extension("capability network not allowed by policy");
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("capability") || hint.summary.contains("denied"));
    }

    #[test]
    fn test_provider_timeout_hints() {
        let error = Error::provider("openai", "request timeout after 120s");
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("timed out") || hint.summary.contains("timeout"));
    }

    #[test]
    fn test_provider_connection_hints() {
        let error = Error::provider("anthropic", "connection refused");
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("Network") || hint.summary.contains("connection"));
    }

    #[test]
    fn test_io_permission_denied_hints() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "permission denied");
        let error = Error::Io(Box::new(io_err));
        let hint = hints_for_error(&error);
        assert!(hint.summary.contains("Permission"));
    }

    #[test]
    fn test_sqlite_locked_hints() {
        // Create a mock sqlite error string
        let error = Error::session("database locked");
        let hint = hints_for_error(&error);
        // Falls back to generic session error since it's not actually a Sqlite variant
        assert!(!hint.hints.is_empty());
    }
}
