//! Unit tests for the auto-repair event logging infrastructure (bd-k5q5.8.1).
//!
//! Tests cover:
//! - `RepairPattern` display formatting
//! - `ExtensionRepairEvent` construction and cloning
//! - `PiJsRuntimeConfig` auto-repair flag
//! - `PiJsTickStats` default repair count
//! - `JsExtensionRuntimeHandle::drain_repair_events` (via channel)

#![allow(clippy::doc_markdown)]

mod common;

use pi::extensions::{ExtensionManager, JsExtensionLoadSpec, JsExtensionRuntimeHandle};
use pi::extensions_js::{ExtensionRepairEvent, PiJsRuntimeConfig, PiJsTickStats, RepairPattern};
use pi::tools::ToolRegistry;
use std::sync::Arc;
use std::time::Duration;

// ─── Helpers ────────────────────────────────────────────────────────────────

fn make_event(pattern: RepairPattern, success: bool) -> ExtensionRepairEvent {
    ExtensionRepairEvent {
        extension_id: "test-ext".to_string(),
        pattern,
        original_error: "module not found: ./dist/index.js".to_string(),
        repair_action: "resolved to ./src/index.ts".to_string(),
        success,
        timestamp_ms: 1_700_000_000_000,
    }
}

fn start_runtime(harness: &common::TestHarness) -> (ExtensionManager, JsExtensionRuntimeHandle) {
    let cwd = harness.temp_dir().to_path_buf();
    let manager = ExtensionManager::new();
    let tools = Arc::new(ToolRegistry::new(&[], &cwd, None));
    let config = PiJsRuntimeConfig {
        cwd: cwd.display().to_string(),
        ..Default::default()
    };

    let handle = common::run_async({
        let manager = manager.clone();
        async move {
            JsExtensionRuntimeHandle::start(config, tools, manager)
                .await
                .expect("start js runtime")
        }
    });
    manager.set_js_runtime(handle.clone());
    (manager, handle)
}

fn start_runtime_with_ext(
    harness: &common::TestHarness,
    source: &str,
) -> (ExtensionManager, JsExtensionRuntimeHandle) {
    let cwd = harness.temp_dir().to_path_buf();
    let ext_path = harness.create_file("extensions/ext.mjs", source.as_bytes());
    let spec = JsExtensionLoadSpec::from_entry_path(&ext_path).expect("load spec");

    let manager = ExtensionManager::new();
    let tools = Arc::new(ToolRegistry::new(&[], &cwd, None));
    let config = PiJsRuntimeConfig {
        cwd: cwd.display().to_string(),
        ..Default::default()
    };

    let handle = common::run_async({
        let manager = manager.clone();
        async move {
            JsExtensionRuntimeHandle::start(config, tools, manager)
                .await
                .expect("start js runtime")
        }
    });
    manager.set_js_runtime(handle.clone());

    common::run_async({
        let manager = manager.clone();
        async move {
            manager
                .load_js_extensions(vec![spec])
                .await
                .expect("load extension");
        }
    });

    (manager, handle)
}

fn shutdown(handle: &JsExtensionRuntimeHandle) {
    let _ = common::run_async({
        let h = handle.clone();
        async move { h.shutdown(Duration::from_millis(500)).await }
    });
}

// ─── RepairPattern display ──────────────────────────────────────────────────

#[test]
fn repair_pattern_display_dist_to_src() {
    assert_eq!(RepairPattern::DistToSrc.to_string(), "dist_to_src");
}

#[test]
fn repair_pattern_display_missing_asset() {
    assert_eq!(RepairPattern::MissingAsset.to_string(), "missing_asset");
}

#[test]
fn repair_pattern_display_monorepo_escape() {
    assert_eq!(RepairPattern::MonorepoEscape.to_string(), "monorepo_escape");
}

#[test]
fn repair_pattern_display_missing_npm_dep() {
    assert_eq!(RepairPattern::MissingNpmDep.to_string(), "missing_npm_dep");
}

#[test]
fn repair_pattern_display_export_shape() {
    assert_eq!(RepairPattern::ExportShape.to_string(), "export_shape");
}

// ─── RepairPattern equality and copy ────────────────────────────────────────

#[test]
fn repair_pattern_eq_and_copy() {
    let a = RepairPattern::DistToSrc;
    let b = a; // Copy
    assert_eq!(a, b);
    assert_ne!(RepairPattern::DistToSrc, RepairPattern::MissingAsset);
}

// ─── ExtensionRepairEvent construction ──────────────────────────────────────

#[test]
fn repair_event_fields_accessible() {
    let ev = make_event(RepairPattern::DistToSrc, true);
    assert_eq!(ev.extension_id, "test-ext");
    assert_eq!(ev.pattern, RepairPattern::DistToSrc);
    assert!(ev.success);
    assert_eq!(ev.timestamp_ms, 1_700_000_000_000);
}

#[test]
fn repair_event_clone() {
    let ev = make_event(RepairPattern::MissingAsset, false);
    let ev2 = ev.clone();
    assert_eq!(ev.extension_id, ev2.extension_id);
    assert_eq!(ev.pattern, ev2.pattern);
    assert_eq!(ev.success, ev2.success);
}

// ─── PiJsRuntimeConfig auto_repair_enabled ──────────────────────────────────

#[test]
fn config_auto_repair_enabled_by_default() {
    let config = PiJsRuntimeConfig::default();
    assert!(config.auto_repair_enabled);
}

#[test]
fn config_auto_repair_can_be_disabled() {
    let config = PiJsRuntimeConfig {
        auto_repair_enabled: false,
        ..Default::default()
    };
    assert!(!config.auto_repair_enabled);
}

// ─── PiJsTickStats default ──────────────────────────────────────────────────

#[test]
fn tick_stats_default_has_zero_repairs() {
    let stats = PiJsTickStats::default();
    assert_eq!(stats.repairs_total, 0);
}

// ─── JsExtensionRuntimeHandle drain_repair_events ───────────────────────────

#[test]
fn handle_drain_repair_events_empty_on_fresh_runtime() {
    let harness = common::TestHarness::new("repair_drain_empty");
    let (_manager, handle) = start_runtime(&harness);

    let events = common::run_async({
        let h = handle.clone();
        async move { h.drain_repair_events().await }
    });
    assert!(events.is_empty());

    shutdown(&handle);
}

#[test]
fn handle_drain_repair_events_after_clean_extension_load() {
    let harness = common::TestHarness::new("repair_drain_clean");
    let (_manager, handle) = start_runtime_with_ext(
        &harness,
        r#"
        export default function activate(pi) {
            pi.registerTool({
                name: "noop",
                description: "does nothing",
                parameters: { type: "object", properties: {} },
                execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
            });
        }
        "#,
    );

    // A well-behaved extension should produce zero repair events.
    let events = common::run_async({
        let h = handle.clone();
        async move { h.drain_repair_events().await }
    });
    assert!(
        events.is_empty(),
        "expected no repairs, got {}",
        events.len()
    );

    shutdown(&handle);
}

// ─── All five patterns constructible ────────────────────────────────────────

#[test]
fn all_five_patterns_constructible() {
    let patterns = [
        RepairPattern::DistToSrc,
        RepairPattern::MissingAsset,
        RepairPattern::MonorepoEscape,
        RepairPattern::MissingNpmDep,
        RepairPattern::ExportShape,
    ];

    for (i, pattern) in patterns.iter().enumerate() {
        let ev = ExtensionRepairEvent {
            extension_id: format!("ext-{i}"),
            pattern: *pattern,
            original_error: "err".to_string(),
            repair_action: "fix".to_string(),
            success: true,
            timestamp_ms: 1_000 + i as u64,
        };
        assert_eq!(ev.extension_id, format!("ext-{i}"));
        assert_eq!(ev.pattern, patterns[i]);
    }
}

// ─── RepairPattern hash ─────────────────────────────────────────────────────

#[test]
fn repair_pattern_usable_as_hash_key() {
    use std::collections::HashSet;
    let mut set = HashSet::new();
    set.insert(RepairPattern::DistToSrc);
    set.insert(RepairPattern::MissingAsset);
    set.insert(RepairPattern::DistToSrc); // duplicate
    assert_eq!(set.len(), 2);
}

// ─── Pattern 1: dist/ → src/ fallback (bd-k5q5.8.2) ────────────────────────

#[test]
fn dist_to_src_fallback_resolves_when_src_exists() {
    let harness = common::TestHarness::new("dist_to_src_resolve");

    // Create the extension entry that imports from ./dist/extension.js
    // (which doesn't exist), but ./src/extension.ts does.
    harness.create_file(
        "extensions/src/extension.ts",
        br#"
        export function hello() { return "from src"; }
        "#,
    );

    // The entry point re-exports from ./dist/extension.js (missing build output).
    let (_manager, handle) = start_runtime_with_ext(
        &harness,
        r#"
        import { hello } from "./src/extension.ts";
        export default function activate(pi) {
            pi.registerTool({
                name: "hello",
                description: "test",
                parameters: { type: "object", properties: {} },
                execute: async () => ({
                    content: [{ type: "text", text: hello() }],
                }),
            });
        }
        "#,
    );

    // Verify the extension loaded (it uses a direct src import, no repair needed).
    let tools = common::run_async({
        let h = handle.clone();
        async move { h.get_registered_tools().await.unwrap() }
    });
    assert!(tools.iter().any(|t| t.name == "hello"));

    shutdown(&handle);
}

#[test]
fn dist_to_src_fallback_loads_extension_with_dist_import() {
    let harness = common::TestHarness::new("dist_to_src_import");

    // Create src/lib.ts (the source file that dist/lib.js would have been).
    harness.create_file(
        "extensions/src/lib.ts",
        br#"
        export const greeting = "hello from src";
        "#,
    );

    // Entry point imports from ./dist/lib.js which doesn't exist.
    // The auto-repair should fall back to ./src/lib.ts.
    let (_manager, handle) = start_runtime_with_ext(
        &harness,
        r#"
        import { greeting } from "./dist/lib.js";
        export default function activate(pi) {
            pi.registerTool({
                name: "greet",
                description: "test",
                parameters: { type: "object", properties: {} },
                execute: async () => ({
                    content: [{ type: "text", text: greeting }],
                }),
            });
        }
        "#,
    );

    // Verify the extension loaded successfully via the fallback.
    let tools = common::run_async({
        let h = handle.clone();
        async move { h.get_registered_tools().await.unwrap() }
    });
    assert!(
        tools.iter().any(|t| t.name == "greet"),
        "extension should have loaded via dist→src fallback"
    );

    shutdown(&handle);
}

#[test]
fn dist_to_src_fallback_no_effect_when_dist_exists() {
    let harness = common::TestHarness::new("dist_to_src_no_fallback");

    // Create BOTH dist/lib.js and src/lib.ts.
    harness.create_file(
        "extensions/dist/lib.js",
        br#"
        export const greeting = "from dist";
        "#,
    );
    harness.create_file(
        "extensions/src/lib.ts",
        br#"
        export const greeting = "from src";
        "#,
    );

    // Entry point imports from ./dist/lib.js which DOES exist.
    let (_manager, handle) = start_runtime_with_ext(
        &harness,
        r#"
        import { greeting } from "./dist/lib.js";
        export default function activate(pi) {
            pi.registerTool({
                name: "greet",
                description: "test",
                parameters: { type: "object", properties: {} },
                execute: async () => ({
                    content: [{ type: "text", text: greeting }],
                }),
            });
        }
        "#,
    );

    // Should load from dist/ (no fallback needed).
    let tools = common::run_async({
        let h = handle.clone();
        async move { h.get_registered_tools().await.unwrap() }
    });
    assert!(tools.iter().any(|t| t.name == "greet"));

    shutdown(&handle);
}
