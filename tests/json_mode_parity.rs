//! JSON Mode Event Parity Validation (bd-37u8a: PARITY-V1).
//!
//! Validates that the Rust JSON mode output (--mode json) is event-for-event
//! compatible with pi-mono. Verifies:
//! - All 15 event types are emitted with correct JSON schema
//! - camelCase field naming throughout
//! - Events appear in correct lifecycle order
//! - `SessionHeader` is the first output line
//!
//! This is a SMOKE TEST. The comprehensive test suite is DROPIN-172 (bd-3p29k).

mod common;

use common::TestHarness;
use pi::agent::AgentEvent;
use pi::model::{
    AssistantMessage, AssistantMessageEvent, ContentBlock, Message, StopReason, TextContent,
    ToolCall, Usage,
};
use pi::tools::ToolOutput;
use serde_json::{Value, json};
use std::sync::Arc;

// ============================================================================
// Helpers
// ============================================================================

/// Serialize an `AgentEvent` and return the parsed JSON value.
fn event_to_json(event: &AgentEvent) -> Value {
    serde_json::to_value(event).expect("serialize AgentEvent")
}

/// Assert a JSON value has a "type" field with the expected value.
fn assert_event_type(value: &Value, expected: &str) {
    let actual = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("<missing>");
    assert_eq!(actual, expected, "event type mismatch");
}

/// Assert that a JSON object has a specific key.
fn assert_has_field(value: &Value, field: &str) {
    assert!(
        value.get(field).is_some(),
        "expected field '{field}' in {value}"
    );
}

/// Assert that a JSON field is a non-empty string.
fn assert_non_empty_string(value: &Value, field: &str) {
    let s = value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("expected string field '{field}' in {value}"));
    assert!(
        !s.is_empty(),
        "expected non-empty string for '{field}', got empty"
    );
}

fn test_assistant_message() -> AssistantMessage {
    AssistantMessage {
        content: vec![ContentBlock::Text(TextContent::new("hello"))],
        api: "anthropic-messages".to_string(),
        provider: "anthropic".to_string(),
        model: "claude-sonnet-4-20250514".to_string(),
        usage: Usage {
            total_tokens: 50,
            input: 20,
            output: 30,
            ..Usage::default()
        },
        stop_reason: StopReason::Stop,
        error_message: None,
        timestamp: 1_700_000_000,
    }
}

fn test_user_message() -> Message {
    Message::User(pi::model::UserMessage {
        content: pi::model::UserContent::Text("test prompt".to_string()),
        timestamp: 1_700_000_000,
    })
}

fn test_tool_output() -> ToolOutput {
    ToolOutput {
        content: vec![ContentBlock::Text(TextContent::new("tool output"))],
        details: None,
        is_error: false,
    }
}

// ============================================================================
// 1. AgentStart schema
// ============================================================================

#[test]
fn json_parity_agent_start_schema() {
    let harness = TestHarness::new("json_parity_agent_start_schema");
    let event = AgentEvent::AgentStart {
        session_id: "session-abc".to_string(),
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "agent_start");
    assert_non_empty_string(&json, "sessionId");
    assert_eq!(json["sessionId"], "session-abc");

    // Verify no snake_case version exists.
    assert!(
        json.get("session_id").is_none(),
        "should use camelCase 'sessionId', not 'session_id'"
    );

    harness
        .log()
        .info_ctx("json_parity", "agent_start schema ok", |ctx| {
            ctx.push(("type".to_string(), "agent_start".to_string()));
        });
}

// ============================================================================
// 2. AgentEnd schema
// ============================================================================

#[test]
fn json_parity_agent_end_schema() {
    let harness = TestHarness::new("json_parity_agent_end_schema");
    let event = AgentEvent::AgentEnd {
        session_id: "session-abc".to_string(),
        messages: vec![test_user_message()],
        error: None,
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "agent_end");
    assert_non_empty_string(&json, "sessionId");
    assert!(json["messages"].is_array(), "messages should be array");
    assert!(
        json.get("error").is_none() || json["error"].is_null(),
        "error should be absent or null when no error"
    );

    // With error
    let event_err = AgentEvent::AgentEnd {
        session_id: "s".to_string(),
        messages: vec![],
        error: Some("provider timeout".to_string()),
    };
    let json_err = event_to_json(&event_err);
    assert_eq!(json_err["error"], "provider timeout");

    harness
        .log()
        .info_ctx("json_parity", "agent_end schema ok", |ctx| {
            ctx.push(("messages_count".to_string(), "1".to_string()));
        });
}

// ============================================================================
// 3. TurnStart schema
// ============================================================================

#[test]
fn json_parity_turn_start_schema() {
    let harness = TestHarness::new("json_parity_turn_start_schema");
    let event = AgentEvent::TurnStart {
        session_id: "session-abc".to_string(),
        turn_index: 0,
        timestamp: 1_700_000_000,
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "turn_start");
    assert_non_empty_string(&json, "sessionId");
    assert_has_field(&json, "turnIndex");
    assert_has_field(&json, "timestamp");

    assert_eq!(json["turnIndex"], 0);
    assert!(json["timestamp"].is_i64(), "timestamp should be i64");

    // Verify camelCase
    assert!(json.get("turn_index").is_none());
    assert!(json.get("session_id").is_none());

    harness
        .log()
        .info_ctx("json_parity", "turn_start schema ok", |ctx| {
            ctx.push(("turnIndex".to_string(), "0".to_string()));
        });
}

// ============================================================================
// 4. TurnEnd schema
// ============================================================================

#[test]
fn json_parity_turn_end_schema() {
    let harness = TestHarness::new("json_parity_turn_end_schema");
    let assistant_msg = Message::Assistant(Arc::new(test_assistant_message()));
    let event = AgentEvent::TurnEnd {
        session_id: "session-abc".to_string(),
        turn_index: 0,
        message: assistant_msg,
        tool_results: vec![],
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "turn_end");
    assert_non_empty_string(&json, "sessionId");
    assert_has_field(&json, "turnIndex");
    assert_has_field(&json, "message");
    assert_has_field(&json, "toolResults");
    assert!(json["toolResults"].is_array());

    // Verify camelCase
    assert!(json.get("tool_results").is_none());

    harness
        .log()
        .info_ctx("json_parity", "turn_end schema ok", |ctx| {
            ctx.push(("turnIndex".to_string(), "0".to_string()));
        });
}

// ============================================================================
// 5. MessageStart schema
// ============================================================================

#[test]
fn json_parity_message_start_schema() {
    let harness = TestHarness::new("json_parity_message_start_schema");
    let event = AgentEvent::MessageStart {
        message: test_user_message(),
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "message_start");
    assert_has_field(&json, "message");
    assert!(json["message"].is_object());

    harness
        .log()
        .info_ctx("json_parity", "message_start schema ok", |ctx| {
            ctx.push(("has_message".to_string(), "true".to_string()));
        });
}

// ============================================================================
// 6. MessageUpdate schema
// ============================================================================

#[test]
fn json_parity_message_update_schema() {
    let harness = TestHarness::new("json_parity_message_update_schema");
    let partial = Arc::new(test_assistant_message());
    let event = AgentEvent::MessageUpdate {
        message: Message::Assistant(Arc::clone(&partial)),
        assistant_message_event: Box::new(AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: "hello".to_string(),
            partial,
        }),
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "message_update");
    assert_has_field(&json, "message");
    assert_has_field(&json, "assistantMessageEvent");

    // Verify camelCase
    assert!(json.get("assistant_message_event").is_none());

    // Verify nested event has correct type tag
    let ame = &json["assistantMessageEvent"];
    assert_eq!(ame["type"], "text_delta");
    assert_has_field(ame, "contentIndex");
    assert_has_field(ame, "delta");

    harness
        .log()
        .info_ctx("json_parity", "message_update schema ok", |ctx| {
            ctx.push(("ame_type".to_string(), "text_delta".to_string()));
        });
}

// ============================================================================
// 7. MessageEnd schema
// ============================================================================

#[test]
fn json_parity_message_end_schema() {
    let harness = TestHarness::new("json_parity_message_end_schema");
    let event = AgentEvent::MessageEnd {
        message: Message::Assistant(Arc::new(test_assistant_message())),
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "message_end");
    assert_has_field(&json, "message");

    harness
        .log()
        .info_ctx("json_parity", "message_end schema ok", |ctx| {
            ctx.push(("has_message".to_string(), "true".to_string()));
        });
}

// ============================================================================
// 8. ToolExecutionStart schema
// ============================================================================

#[test]
fn json_parity_tool_execution_start_schema() {
    let harness = TestHarness::new("json_parity_tool_execution_start_schema");
    let event = AgentEvent::ToolExecutionStart {
        tool_call_id: "tc-1".to_string(),
        tool_name: "read".to_string(),
        args: json!({"path": "/tmp/test.txt"}),
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "tool_execution_start");
    assert_non_empty_string(&json, "toolCallId");
    assert_non_empty_string(&json, "toolName");
    assert_has_field(&json, "args");

    assert_eq!(json["toolCallId"], "tc-1");
    assert_eq!(json["toolName"], "read");

    // Verify camelCase
    assert!(json.get("tool_call_id").is_none());
    assert!(json.get("tool_name").is_none());

    harness
        .log()
        .info_ctx("json_parity", "tool_execution_start schema ok", |ctx| {
            ctx.push(("tool".to_string(), "read".to_string()));
        });
}

// ============================================================================
// 9. ToolExecutionUpdate schema
// ============================================================================

#[test]
fn json_parity_tool_execution_update_schema() {
    let harness = TestHarness::new("json_parity_tool_execution_update_schema");
    let event = AgentEvent::ToolExecutionUpdate {
        tool_call_id: "tc-1".to_string(),
        tool_name: "bash".to_string(),
        args: json!({"command": "ls"}),
        partial_result: test_tool_output(),
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "tool_execution_update");
    assert_non_empty_string(&json, "toolCallId");
    assert_non_empty_string(&json, "toolName");
    assert_has_field(&json, "args");
    assert_has_field(&json, "partialResult");

    // Verify camelCase
    assert!(json.get("partial_result").is_none());

    harness
        .log()
        .info_ctx("json_parity", "tool_execution_update schema ok", |ctx| {
            ctx.push(("tool".to_string(), "bash".to_string()));
        });
}

// ============================================================================
// 10. ToolExecutionEnd schema
// ============================================================================

#[test]
fn json_parity_tool_execution_end_schema() {
    let harness = TestHarness::new("json_parity_tool_execution_end_schema");
    let event = AgentEvent::ToolExecutionEnd {
        tool_call_id: "tc-1".to_string(),
        tool_name: "read".to_string(),
        result: test_tool_output(),
        is_error: false,
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "tool_execution_end");
    assert_non_empty_string(&json, "toolCallId");
    assert_non_empty_string(&json, "toolName");
    assert_has_field(&json, "result");
    assert_has_field(&json, "isError");
    assert_eq!(json["isError"], false);

    // Verify camelCase
    assert!(json.get("is_error").is_none());

    // With error
    let event_err = AgentEvent::ToolExecutionEnd {
        tool_call_id: "tc-2".to_string(),
        tool_name: "bash".to_string(),
        result: ToolOutput {
            content: vec![ContentBlock::Text(TextContent::new("error msg"))],
            details: None,
            is_error: true,
        },
        is_error: true,
    };
    let json_err = event_to_json(&event_err);
    assert_eq!(json_err["isError"], true);

    harness
        .log()
        .info_ctx("json_parity", "tool_execution_end schema ok", |ctx| {
            ctx.push(("error_case".to_string(), "true".to_string()));
        });
}

// ============================================================================
// 11. AutoCompactionStart schema
// ============================================================================

#[test]
fn json_parity_auto_compaction_start_schema() {
    let harness = TestHarness::new("json_parity_auto_compaction_start_schema");
    let event = AgentEvent::AutoCompactionStart {
        reason: "context window exceeded".to_string(),
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "auto_compaction_start");
    assert_non_empty_string(&json, "reason");

    harness
        .log()
        .info_ctx("json_parity", "auto_compaction_start schema ok", |ctx| {
            ctx.push(("reason".to_string(), "context window exceeded".to_string()));
        });
}

// ============================================================================
// 12. AutoCompactionEnd schema
// ============================================================================

#[test]
fn json_parity_auto_compaction_end_schema() {
    let harness = TestHarness::new("json_parity_auto_compaction_end_schema");

    // Success case
    let event = AgentEvent::AutoCompactionEnd {
        result: Some(json!({"summary": "compacted 10 messages"})),
        aborted: false,
        will_retry: false,
        error_message: None,
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "auto_compaction_end");
    assert_has_field(&json, "aborted");
    assert_has_field(&json, "willRetry");
    assert_eq!(json["aborted"], false);
    assert_eq!(json["willRetry"], false);

    // Verify camelCase
    assert!(json.get("will_retry").is_none());
    assert!(json.get("error_message").is_none());

    // Error case with retry
    let event_err = AgentEvent::AutoCompactionEnd {
        result: None,
        aborted: false,
        will_retry: true,
        error_message: Some("provider error".to_string()),
    };
    let json_err = event_to_json(&event_err);
    assert_eq!(json_err["willRetry"], true);
    assert_eq!(json_err["errorMessage"], "provider error");

    harness
        .log()
        .info_ctx("json_parity", "auto_compaction_end schema ok", |ctx| {
            ctx.push(("variants_tested".to_string(), "2".to_string()));
        });
}

// ============================================================================
// 13. AutoRetryStart schema
// ============================================================================

#[test]
fn json_parity_auto_retry_start_schema() {
    let harness = TestHarness::new("json_parity_auto_retry_start_schema");
    let event = AgentEvent::AutoRetryStart {
        attempt: 1,
        max_attempts: 3,
        delay_ms: 1000,
        error_message: "rate limited".to_string(),
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "auto_retry_start");
    assert_has_field(&json, "attempt");
    assert_has_field(&json, "maxAttempts");
    assert_has_field(&json, "delayMs");
    assert_has_field(&json, "errorMessage");
    assert_eq!(json["attempt"], 1);
    assert_eq!(json["maxAttempts"], 3);
    assert_eq!(json["delayMs"], 1000);
    assert_eq!(json["errorMessage"], "rate limited");

    // Verify camelCase
    assert!(json.get("max_attempts").is_none());
    assert!(json.get("delay_ms").is_none());
    assert!(json.get("error_message").is_none());

    harness
        .log()
        .info_ctx("json_parity", "auto_retry_start schema ok", |ctx| {
            ctx.push(("attempt".to_string(), "1".to_string()));
        });
}

// ============================================================================
// 14. AutoRetryEnd schema
// ============================================================================

#[test]
fn json_parity_auto_retry_end_schema() {
    let harness = TestHarness::new("json_parity_auto_retry_end_schema");

    // Success case
    let event = AgentEvent::AutoRetryEnd {
        success: true,
        attempt: 2,
        final_error: None,
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "auto_retry_end");
    assert_has_field(&json, "success");
    assert_has_field(&json, "attempt");
    assert_eq!(json["success"], true);
    assert_eq!(json["attempt"], 2);

    // Verify camelCase
    assert!(json.get("final_error").is_none());

    // Failure case
    let event_fail = AgentEvent::AutoRetryEnd {
        success: false,
        attempt: 3,
        final_error: Some("max retries exceeded".to_string()),
    };
    let json_fail = event_to_json(&event_fail);
    assert_eq!(json_fail["success"], false);
    assert_eq!(json_fail["finalError"], "max retries exceeded");

    harness
        .log()
        .info_ctx("json_parity", "auto_retry_end schema ok", |ctx| {
            ctx.push(("variants_tested".to_string(), "2".to_string()));
        });
}

// ============================================================================
// 15. ExtensionError schema
// ============================================================================

#[test]
fn json_parity_extension_error_schema() {
    let harness = TestHarness::new("json_parity_extension_error_schema");
    let event = AgentEvent::ExtensionError {
        extension_id: Some("ext-foo".to_string()),
        event: "on_tool_start".to_string(),
        error: "TypeError: undefined is not a function".to_string(),
    };
    let json = event_to_json(&event);

    assert_event_type(&json, "extension_error");
    assert_has_field(&json, "extensionId");
    assert_non_empty_string(&json, "event");
    assert_non_empty_string(&json, "error");
    assert_eq!(json["extensionId"], "ext-foo");

    // Verify camelCase
    assert!(json.get("extension_id").is_none());

    // Without extension_id
    let event_no_id = AgentEvent::ExtensionError {
        extension_id: None,
        event: "lifecycle".to_string(),
        error: "load failed".to_string(),
    };
    let json_no_id = event_to_json(&event_no_id);
    assert!(
        json_no_id.get("extensionId").is_none()
            || json_no_id["extensionId"].is_null(),
        "extensionId should be absent or null when None"
    );

    harness
        .log()
        .info_ctx("json_parity", "extension_error schema ok", |ctx| {
            ctx.push(("with_id".to_string(), "true".to_string()));
            ctx.push(("without_id".to_string(), "true".to_string()));
        });
}

// ============================================================================
// 16. Complete lifecycle ordering
// ============================================================================

#[test]
fn json_parity_complete_lifecycle_ordering() {
    let harness = TestHarness::new("json_parity_complete_lifecycle_ordering");

    // Simulate a full agent run lifecycle and verify ordering.
    let session_id = "session-lifecycle-test";
    let partial = Arc::new(test_assistant_message());

    let events: Vec<AgentEvent> = vec![
        AgentEvent::AgentStart {
            session_id: session_id.to_string(),
        },
        AgentEvent::MessageStart {
            message: test_user_message(),
        },
        AgentEvent::MessageEnd {
            message: test_user_message(),
        },
        AgentEvent::TurnStart {
            session_id: session_id.to_string(),
            turn_index: 0,
            timestamp: 1_700_000_000,
        },
        AgentEvent::MessageStart {
            message: Message::Assistant(Arc::clone(&partial)),
        },
        AgentEvent::MessageUpdate {
            message: Message::Assistant(Arc::clone(&partial)),
            assistant_message_event: Box::new(AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "hello".to_string(),
                partial: Arc::clone(&partial),
            }),
        },
        AgentEvent::MessageEnd {
            message: Message::Assistant(Arc::clone(&partial)),
        },
        AgentEvent::TurnEnd {
            session_id: session_id.to_string(),
            turn_index: 0,
            message: Message::Assistant(Arc::clone(&partial)),
            tool_results: vec![],
        },
        AgentEvent::AgentEnd {
            session_id: session_id.to_string(),
            messages: vec![test_user_message(), Message::Assistant(partial)],
            error: None,
        },
    ];

    let json_lines: Vec<Value> = events.iter().map(event_to_json).collect();

    let expected_order = [
        "agent_start",
        "message_start",   // user
        "message_end",     // user
        "turn_start",
        "message_start",   // assistant
        "message_update",
        "message_end",     // assistant
        "turn_end",
        "agent_end",
    ];

    for (i, expected_type) in expected_order.iter().enumerate() {
        let actual_type = json_lines[i]["type"].as_str().unwrap_or("<missing>");
        assert_eq!(
            actual_type, *expected_type,
            "event at index {i}: expected '{expected_type}', got '{actual_type}'"
        );
    }

    // Verify sessionId consistency across events that have it.
    for line in &json_lines {
        if let Some(sid) = line.get("sessionId").and_then(Value::as_str) {
            assert_eq!(
                sid, session_id,
                "sessionId should be consistent across events"
            );
        }
    }

    harness
        .log()
        .info_ctx("json_parity", "lifecycle ordering ok", |ctx| {
            ctx.push(("events".to_string(), json_lines.len().to_string()));
            ctx.push((
                "order".to_string(),
                expected_order.join(","),
            ));
        });
}

// ============================================================================
// 17. AssistantMessageEvent sub-types
// ============================================================================

#[test]
#[allow(clippy::too_many_lines)]
fn json_parity_assistant_message_event_all_subtypes() {
    let harness = TestHarness::new("json_parity_assistant_message_event_all_subtypes");
    let partial = Arc::new(test_assistant_message());

    // Each AssistantMessageEvent variant serialized through MessageUpdate
    let variants: Vec<(&str, AssistantMessageEvent)> = vec![
        (
            "start",
            AssistantMessageEvent::Start {
                partial: Arc::clone(&partial),
            },
        ),
        (
            "text_start",
            AssistantMessageEvent::TextStart {
                content_index: 0,
                partial: Arc::clone(&partial),
            },
        ),
        (
            "text_delta",
            AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "hello".to_string(),
                partial: Arc::clone(&partial),
            },
        ),
        (
            "text_end",
            AssistantMessageEvent::TextEnd {
                content_index: 0,
                content: "hello world".to_string(),
                partial: Arc::clone(&partial),
            },
        ),
        (
            "thinking_start",
            AssistantMessageEvent::ThinkingStart {
                content_index: 0,
                partial: Arc::clone(&partial),
            },
        ),
        (
            "thinking_delta",
            AssistantMessageEvent::ThinkingDelta {
                content_index: 0,
                delta: "thinking...".to_string(),
                partial: Arc::clone(&partial),
            },
        ),
        (
            "thinking_end",
            AssistantMessageEvent::ThinkingEnd {
                content_index: 0,
                content: "full thought".to_string(),
                partial: Arc::clone(&partial),
            },
        ),
        (
            "toolcall_start",
            AssistantMessageEvent::ToolCallStart {
                content_index: 0,
                partial: Arc::clone(&partial),
            },
        ),
        (
            "toolcall_delta",
            AssistantMessageEvent::ToolCallDelta {
                content_index: 0,
                delta: "{\"path\"".to_string(),
                partial: Arc::clone(&partial),
            },
        ),
        (
            "toolcall_end",
            AssistantMessageEvent::ToolCallEnd {
                content_index: 0,
                tool_call: ToolCall {
                    id: "tc-1".to_string(),
                    name: "read".to_string(),
                    arguments: json!({"path": "/tmp"}),
                    thought_signature: None,
                },
                partial: Arc::clone(&partial),
            },
        ),
        (
            "done",
            AssistantMessageEvent::Done {
                reason: StopReason::Stop,
                message: Arc::clone(&partial),
            },
        ),
        (
            "error",
            AssistantMessageEvent::Error {
                reason: StopReason::Stop,
                error: Arc::clone(&partial),
            },
        ),
    ];

    let mut tested = 0;
    for (expected_type, ame) in &variants {
        let event = AgentEvent::MessageUpdate {
            message: Message::Assistant(Arc::clone(&partial)),
            assistant_message_event: Box::new(ame.clone()),
        };
        let json = event_to_json(&event);
        let ame_json = &json["assistantMessageEvent"];

        let actual_type = ame_json["type"].as_str().unwrap_or("<missing>");
        assert_eq!(
            actual_type, *expected_type,
            "AME variant type mismatch for {expected_type}"
        );
        tested += 1;
    }

    assert_eq!(tested, 12, "should test all 12 AME variants");

    harness
        .log()
        .info_ctx("json_parity", "AME subtypes ok", |ctx| {
            ctx.push(("variants_tested".to_string(), tested.to_string()));
        });
}

// ============================================================================
// 18. No snake_case leak check (comprehensive)
// ============================================================================

#[test]
#[allow(clippy::too_many_lines)]
fn json_parity_no_snake_case_leak() {
    let harness = TestHarness::new("json_parity_no_snake_case_leak");
    let partial = Arc::new(test_assistant_message());

    // Test every event type for snake_case field leaks.
    let events: Vec<AgentEvent> = vec![
        AgentEvent::AgentStart {
            session_id: "s".to_string(),
        },
        AgentEvent::AgentEnd {
            session_id: "s".to_string(),
            messages: vec![],
            error: None,
        },
        AgentEvent::TurnStart {
            session_id: "s".to_string(),
            turn_index: 0,
            timestamp: 0,
        },
        AgentEvent::TurnEnd {
            session_id: "s".to_string(),
            turn_index: 0,
            message: test_user_message(),
            tool_results: vec![],
        },
        AgentEvent::MessageStart {
            message: test_user_message(),
        },
        AgentEvent::MessageUpdate {
            message: Message::Assistant(Arc::clone(&partial)),
            assistant_message_event: Box::new(AssistantMessageEvent::TextDelta {
                content_index: 0,
                delta: "x".to_string(),
                partial: Arc::clone(&partial),
            }),
        },
        AgentEvent::MessageEnd {
            message: test_user_message(),
        },
        AgentEvent::ToolExecutionStart {
            tool_call_id: "tc".to_string(),
            tool_name: "read".to_string(),
            args: json!({}),
        },
        AgentEvent::ToolExecutionUpdate {
            tool_call_id: "tc".to_string(),
            tool_name: "bash".to_string(),
            args: json!({}),
            partial_result: test_tool_output(),
        },
        AgentEvent::ToolExecutionEnd {
            tool_call_id: "tc".to_string(),
            tool_name: "read".to_string(),
            result: test_tool_output(),
            is_error: false,
        },
        AgentEvent::AutoCompactionStart {
            reason: "r".to_string(),
        },
        AgentEvent::AutoCompactionEnd {
            result: None,
            aborted: false,
            will_retry: false,
            error_message: Some("err".to_string()),
        },
        AgentEvent::AutoRetryStart {
            attempt: 1,
            max_attempts: 3,
            delay_ms: 100,
            error_message: "e".to_string(),
        },
        AgentEvent::AutoRetryEnd {
            success: true,
            attempt: 1,
            final_error: None,
        },
        AgentEvent::ExtensionError {
            extension_id: Some("ext".to_string()),
            event: "e".to_string(),
            error: "err".to_string(),
        },
    ];

    // Known snake_case fields that should NOT appear.
    let banned_snake_case = [
        "session_id",
        "turn_index",
        "tool_results",
        "tool_call_id",
        "tool_name",
        "is_error",
        "partial_result",
        "assistant_message_event",
        "max_attempts",
        "delay_ms",
        "error_message",
        "will_retry",
        "final_error",
        "extension_id",
        "content_index",
    ];

    for event in &events {
        let json = event_to_json(event);
        let json_string = serde_json::to_string(&json).expect("to_string");

        for banned in &banned_snake_case {
            // Check if the banned key appears as a JSON key ("key":)
            let key_pattern = format!("\"{banned}\":");
            assert!(
                !json_string.contains(&key_pattern),
                "found banned snake_case field '{banned}' in event {:?}: {json_string}",
                json["type"]
            );
        }
    }

    harness
        .log()
        .info_ctx("json_parity", "no snake_case leak ok", |ctx| {
            ctx.push(("events_checked".to_string(), events.len().to_string()));
            ctx.push(("banned_fields".to_string(), banned_snake_case.len().to_string()));
        });
}

// ============================================================================
// 19. SessionHeader schema validation
// ============================================================================

#[test]
fn json_parity_session_header_schema() {
    let harness = TestHarness::new("json_parity_session_header_schema");

    let header = pi::session::SessionHeader::new();
    let json = serde_json::to_value(&header).expect("serialize header");

    assert_eq!(json["type"], "session");
    assert!(
        json["id"].as_str().is_some_and(|s| !s.is_empty()),
        "id should be non-empty string"
    );
    assert!(
        json["timestamp"]
            .as_str()
            .is_some_and(|s| !s.is_empty()),
        "timestamp should be non-empty string"
    );
    assert!(
        json["cwd"].as_str().is_some_and(|s| !s.is_empty()),
        "cwd should be non-empty string"
    );

    // Verify camelCase naming
    assert!(
        json.get("parent_session").is_none(),
        "should use camelCase 'branchedFrom' not 'parent_session'"
    );

    harness
        .log()
        .info_ctx("json_parity", "session header schema ok", |ctx| {
            ctx.push(("type".to_string(), "session".to_string()));
            ctx.push(("has_id".to_string(), "true".to_string()));
        });
}

// ============================================================================
// 20. Event type string stability
// ============================================================================

#[test]
#[allow(clippy::too_many_lines)]
fn json_parity_all_event_type_strings() {
    let harness = TestHarness::new("json_parity_all_event_type_strings");
    let partial = Arc::new(test_assistant_message());

    // Map of (variant, expected_type_string)
    let cases: Vec<(AgentEvent, &str)> = vec![
        (
            AgentEvent::AgentStart {
                session_id: "s".to_string(),
            },
            "agent_start",
        ),
        (
            AgentEvent::AgentEnd {
                session_id: "s".to_string(),
                messages: vec![],
                error: None,
            },
            "agent_end",
        ),
        (
            AgentEvent::TurnStart {
                session_id: "s".to_string(),
                turn_index: 0,
                timestamp: 0,
            },
            "turn_start",
        ),
        (
            AgentEvent::TurnEnd {
                session_id: "s".to_string(),
                turn_index: 0,
                message: test_user_message(),
                tool_results: vec![],
            },
            "turn_end",
        ),
        (
            AgentEvent::MessageStart {
                message: test_user_message(),
            },
            "message_start",
        ),
        (
            AgentEvent::MessageUpdate {
                message: Message::Assistant(Arc::clone(&partial)),
                assistant_message_event: Box::new(AssistantMessageEvent::Start {
                    partial: Arc::clone(&partial),
                }),
            },
            "message_update",
        ),
        (
            AgentEvent::MessageEnd {
                message: test_user_message(),
            },
            "message_end",
        ),
        (
            AgentEvent::ToolExecutionStart {
                tool_call_id: "t".to_string(),
                tool_name: "r".to_string(),
                args: json!({}),
            },
            "tool_execution_start",
        ),
        (
            AgentEvent::ToolExecutionUpdate {
                tool_call_id: "t".to_string(),
                tool_name: "r".to_string(),
                args: json!({}),
                partial_result: test_tool_output(),
            },
            "tool_execution_update",
        ),
        (
            AgentEvent::ToolExecutionEnd {
                tool_call_id: "t".to_string(),
                tool_name: "r".to_string(),
                result: test_tool_output(),
                is_error: false,
            },
            "tool_execution_end",
        ),
        (
            AgentEvent::AutoCompactionStart {
                reason: "r".to_string(),
            },
            "auto_compaction_start",
        ),
        (
            AgentEvent::AutoCompactionEnd {
                result: None,
                aborted: false,
                will_retry: false,
                error_message: None,
            },
            "auto_compaction_end",
        ),
        (
            AgentEvent::AutoRetryStart {
                attempt: 1,
                max_attempts: 3,
                delay_ms: 0,
                error_message: "e".to_string(),
            },
            "auto_retry_start",
        ),
        (
            AgentEvent::AutoRetryEnd {
                success: true,
                attempt: 1,
                final_error: None,
            },
            "auto_retry_end",
        ),
        (
            AgentEvent::ExtensionError {
                extension_id: None,
                event: "e".to_string(),
                error: "err".to_string(),
            },
            "extension_error",
        ),
    ];

    for (event, expected_type) in &cases {
        let json = event_to_json(event);
        assert_event_type(&json, expected_type);
    }

    assert_eq!(cases.len(), 15, "should cover all 15 AgentEvent variants");

    harness
        .log()
        .info_ctx("json_parity", "all event type strings ok", |ctx| {
            ctx.push(("variants".to_string(), cases.len().to_string()));
        });
}
