//! QuickJS runtime scaffolding for JS-compatible extensions.
//!
//! This module implements the PiJS runtime with Promise-based hostcall bridge:
//! - Async QuickJS runtime + context creation
//! - `pi` global object with Promise-returning hostcall methods
//! - Deterministic event loop scheduler integration
//! - call_id → Promise resolver mapping for hostcall completions
//! - Microtask draining after each macrotask
//!
//! # Architecture (bd-2ke)
//!
//! ```text
//! JS Code                     Rust Host
//! -------                     ---------
//! pi.tool("read", {...})  --> enqueue HostcallRequest
//!   returns Promise           generate call_id
//!   store (resolve, reject)   track pending hostcall
//!
//! [scheduler tick]        <-- host completes hostcall
//!   delivers MacrotaskKind::HostcallComplete
//!   lookup (resolve, reject) by call_id
//!   resolve(result) or reject(error)
//!   drain microtasks (Promises .then chains)
//! ```

use crate::error::{Error, Result};
use crate::scheduler::{Clock, HostcallOutcome, Macrotask, MacrotaskKind, Scheduler};
use rquickjs::function::Func;
use rquickjs::{AsyncContext, AsyncRuntime, Ctx, Function, IntoJs, Object, Promise, Value};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct QuickJsRuntime {
    runtime: AsyncRuntime,
    context: AsyncContext,
}

#[allow(clippy::future_not_send)]
impl QuickJsRuntime {
    pub async fn new() -> Result<Self> {
        let runtime = AsyncRuntime::new().map_err(|err| map_js_error(&err))?;
        let context = AsyncContext::full(&runtime)
            .await
            .map_err(|err| map_js_error(&err))?;
        let instance = Self { runtime, context };
        instance.install_pi_stub().await?;
        Ok(instance)
    }

    pub async fn eval(&self, source: &str) -> Result<()> {
        self.context
            .with(|ctx| ctx.eval::<(), _>(source))
            .await
            .map_err(|err| map_js_error(&err))?;
        Ok(())
    }

    pub async fn eval_file(&self, path: &std::path::Path) -> Result<()> {
        self.context
            .with(|ctx| ctx.eval_file::<(), _>(path))
            .await
            .map_err(|err| map_js_error(&err))?;
        Ok(())
    }

    pub async fn run_pending_jobs(&self) -> Result<()> {
        loop {
            let ran = self
                .runtime
                .execute_pending_job()
                .await
                .map_err(|err| Error::extension(format!("QuickJS job: {err}")))?;
            if !ran {
                break;
            }
        }
        Ok(())
    }

    pub async fn run_until_idle(&self) -> Result<()> {
        self.runtime.idle().await;
        Ok(())
    }

    async fn install_pi_stub(&self) -> Result<()> {
        self.context
            .with(|ctx| {
                let global = ctx.globals();
                let pi = Object::new(ctx)?;

                pi.set(
                    "tool",
                    Func::from(
                        |ctx: Ctx<'_>, _name: String, _input: Value| -> rquickjs::Result<Value> {
                            Err(throw_unimplemented(&ctx, "pi.tool"))
                        },
                    ),
                )?;
                pi.set(
                    "exec",
                    Func::from(
                        |ctx: Ctx<'_>, _cmd: String, _args: Value| -> rquickjs::Result<Value> {
                            Err(throw_unimplemented(&ctx, "pi.exec"))
                        },
                    ),
                )?;
                pi.set(
                    "http",
                    Func::from(|ctx: Ctx<'_>, _req: Value| -> rquickjs::Result<Value> {
                        Err(throw_unimplemented(&ctx, "pi.http"))
                    }),
                )?;
                pi.set(
                    "session",
                    Func::from(
                        |ctx: Ctx<'_>, _op: String, _args: Value| -> rquickjs::Result<Value> {
                            Err(throw_unimplemented(&ctx, "pi.session"))
                        },
                    ),
                )?;
                pi.set(
                    "ui",
                    Func::from(
                        |ctx: Ctx<'_>, _op: String, _args: Value| -> rquickjs::Result<Value> {
                            Err(throw_unimplemented(&ctx, "pi.ui"))
                        },
                    ),
                )?;
                pi.set(
                    "events",
                    Func::from(
                        |ctx: Ctx<'_>, _op: String, _args: Value| -> rquickjs::Result<Value> {
                            Err(throw_unimplemented(&ctx, "pi.events"))
                        },
                    ),
                )?;

                global.set("pi", pi)?;
                Ok(())
            })
            .await
            .map_err(|err| map_js_error(&err))?;
        Ok(())
    }
}

// ============================================================================
// Promise Bridge Types (bd-2ke)
// ============================================================================

/// Type of hostcall being requested from JavaScript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostcallKind {
    /// pi.tool(name, input) - invoke a tool
    Tool { name: String },
    /// pi.exec(cmd, args) - execute a shell command
    Exec { cmd: String },
    /// pi.http(request) - make an HTTP request
    Http,
    /// pi.session(op, args) - session operations
    Session { op: String },
    /// pi.ui(op, args) - UI operations
    Ui { op: String },
    /// pi.events(op, args) - event operations
    Events { op: String },
}

/// A hostcall request enqueued from JavaScript.
#[derive(Debug, Clone)]
pub struct HostcallRequest {
    /// Unique identifier for correlation.
    pub call_id: String,
    /// Type of hostcall.
    pub kind: HostcallKind,
    /// JSON payload for the hostcall.
    pub payload: serde_json::Value,
    /// Trace ID for correlation with macrotask.
    pub trace_id: u64,
}

/// Stores pending Promise resolvers for hostcalls.
///
/// This is the core bridge between JS Promises and Rust async completions.
/// When a pi.* method is called:
/// 1. A Promise is created
/// 2. The (resolve, reject) functions are stored here keyed by call_id
/// 3. When the hostcall completes, we look up and call resolve/reject
pub struct PendingHostcalls<'js> {
    /// Map from call_id to (resolve, reject) functions.
    pending: HashMap<String, (Function<'js>, Function<'js>)>,
    /// Next call_id to assign.
    next_id: u64,
}

impl<'js> PendingHostcalls<'js> {
    /// Create a new empty pending hostcalls tracker.
    #[must_use]
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
            next_id: 1,
        }
    }

    /// Generate a unique call_id.
    pub fn next_call_id(&mut self) -> String {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        format!("call-{id}")
    }

    /// Register a pending hostcall with its resolve/reject functions.
    pub fn register(
        &mut self,
        call_id: String,
        resolve: Function<'js>,
        reject: Function<'js>,
    ) {
        tracing::trace!(
            event = "promise_bridge.register",
            call_id = %call_id,
            pending_count = self.pending.len() + 1,
            "Registered pending hostcall"
        );
        self.pending.insert(call_id, (resolve, reject));
    }

    /// Complete a hostcall by resolving or rejecting its Promise.
    ///
    /// Returns true if the call_id was found and completed.
    pub fn complete(
        &mut self,
        ctx: &Ctx<'js>,
        call_id: &str,
        outcome: &HostcallOutcome,
    ) -> rquickjs::Result<bool> {
        let Some((resolve, reject)) = self.pending.remove(call_id) else {
            tracing::warn!(
                event = "promise_bridge.complete.not_found",
                call_id = %call_id,
                "Hostcall completion for unknown call_id"
            );
            return Ok(false);
        };

        match outcome {
            HostcallOutcome::Success(value) => {
                tracing::trace!(
                    event = "promise_bridge.resolve",
                    call_id = %call_id,
                    "Resolving Promise with success"
                );
                // Convert serde_json::Value to JS Value
                let js_value = json_to_js(ctx, value)?;
                resolve.call::<_, ()>((js_value,))?;
            }
            HostcallOutcome::Error { code, message } => {
                tracing::trace!(
                    event = "promise_bridge.reject",
                    call_id = %call_id,
                    code = %code,
                    message = %message,
                    "Rejecting Promise with error"
                );
                // Create an Error object with code and message
                let error = Object::new(ctx.clone())?;
                error.set("code", code.clone())?;
                error.set("message", message.clone())?;
                reject.call::<_, ()>((error,))?;
            }
        }

        tracing::trace!(
            event = "promise_bridge.complete",
            call_id = %call_id,
            remaining = self.pending.len(),
            "Hostcall completed"
        );
        Ok(true)
    }

    /// Cancel a pending hostcall by rejecting its Promise.
    pub fn cancel(&mut self, ctx: &Ctx<'js>, call_id: &str, reason: &str) -> rquickjs::Result<bool> {
        let Some((_resolve, reject)) = self.pending.remove(call_id) else {
            return Ok(false);
        };

        tracing::trace!(
            event = "promise_bridge.cancel",
            call_id = %call_id,
            reason = %reason,
            "Cancelling pending hostcall"
        );

        let error = Object::new(ctx.clone())?;
        error.set("code", "CANCELLED")?;
        error.set("message", reason)?;
        reject.call::<_, ()>((error,))?;
        Ok(true)
    }

    /// Get the number of pending hostcalls.
    #[must_use]
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    /// Check if there are no pending hostcalls.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Get all pending call_ids for debugging.
    #[must_use]
    pub fn pending_ids(&self) -> Vec<&String> {
        self.pending.keys().collect()
    }
}

impl<'js> Default for PendingHostcalls<'js> {
    fn default() -> Self {
        Self::new()
    }
}

/// Convert a serde_json::Value to a rquickjs Value.
fn json_to_js<'js>(ctx: &Ctx<'js>, value: &serde_json::Value) -> rquickjs::Result<Value<'js>> {
    match value {
        serde_json::Value::Null => Ok(Value::new_null(ctx.clone())),
        serde_json::Value::Bool(b) => Ok(Value::new_bool(ctx.clone(), *b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(Value::new_int(ctx.clone(), i as i32))
            } else if let Some(f) = n.as_f64() {
                Ok(Value::new_float(ctx.clone(), f))
            } else {
                Ok(Value::new_null(ctx.clone()))
            }
        }
        serde_json::Value::String(s) => s.clone().into_js(ctx),
        serde_json::Value::Array(arr) => {
            let js_arr = rquickjs::Array::new(ctx.clone())?;
            for (i, v) in arr.iter().enumerate() {
                let js_v = json_to_js(ctx, v)?;
                js_arr.set(i, js_v)?;
            }
            Ok(js_arr.into_value())
        }
        serde_json::Value::Object(obj) => {
            let js_obj = Object::new(ctx.clone())?;
            for (k, v) in obj {
                let js_v = json_to_js(ctx, v)?;
                js_obj.set(k.as_str(), js_v)?;
            }
            Ok(js_obj.into_value())
        }
    }
}

/// Convert a rquickjs Value to a serde_json::Value.
fn js_to_json<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> rquickjs::Result<serde_json::Value> {
    if value.is_null() || value.is_undefined() {
        return Ok(serde_json::Value::Null);
    }
    if let Some(b) = value.as_bool() {
        return Ok(serde_json::Value::Bool(b));
    }
    if let Some(i) = value.as_int() {
        return Ok(serde_json::json!(i));
    }
    if let Some(f) = value.as_float() {
        return Ok(serde_json::json!(f));
    }
    if let Some(s) = value.as_string() {
        let s = s.to_string()?;
        return Ok(serde_json::Value::String(s));
    }
    if let Some(arr) = value.as_array() {
        let mut result = Vec::new();
        for i in 0..arr.len() {
            if let Some(v) = arr.get::<Value<'js>>(i)? {
                result.push(js_to_json(ctx, v)?);
            }
        }
        return Ok(serde_json::Value::Array(result));
    }
    if let Some(obj) = value.as_object() {
        let mut result = serde_json::Map::new();
        for item in obj.props::<String, Value<'js>>() {
            let (k, v) = item?;
            result.insert(k, js_to_json(ctx, v)?);
        }
        return Ok(serde_json::Value::Object(result));
    }
    // Fallback for functions, symbols, etc.
    Ok(serde_json::Value::Null)
}

/// Queue of hostcall requests waiting to be processed by the host.
pub type HostcallQueue = Rc<RefCell<VecDeque<HostcallRequest>>>;

// ============================================================================
// Deterministic PiJS Event Loop Scheduler (bd-8mm)
// ============================================================================

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

#[derive(Clone)]
pub struct ClockHandle(Arc<dyn Clock>);

impl ClockHandle {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self(clock)
    }
}

impl Clock for ClockHandle {
    fn now_ms(&self) -> u64 {
        self.0.now_ms()
    }
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        u64::try_from(now.as_millis()).unwrap_or(u64::MAX)
    }
}

#[derive(Debug)]
pub struct ManualClock {
    now_ms: AtomicU64,
}

impl ManualClock {
    pub const fn new(start_ms: u64) -> Self {
        Self {
            now_ms: AtomicU64::new(start_ms),
        }
    }

    pub fn set(&self, ms: u64) {
        self.now_ms.store(ms, AtomicOrdering::SeqCst);
    }

    pub fn advance(&self, delta_ms: u64) {
        self.now_ms.fetch_add(delta_ms, AtomicOrdering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.now_ms.load(AtomicOrdering::SeqCst)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacrotaskKind {
    TimerFired { timer_id: u64 },
    HostcallComplete { call_id: String },
    InboundEvent { event_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Macrotask {
    pub seq: u64,
    pub trace_id: u64,
    pub kind: MacrotaskKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MacrotaskEntry {
    seq: u64,
    trace_id: u64,
    kind: MacrotaskKind,
}

impl Ord for MacrotaskEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        self.seq.cmp(&other.seq)
    }
}

impl PartialOrd for MacrotaskEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TimerEntry {
    deadline_ms: u64,
    order_seq: u64,
    timer_id: u64,
    trace_id: u64,
}

impl Ord for TimerEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.deadline_ms, self.order_seq, self.timer_id).cmp(&(
            other.deadline_ms,
            other.order_seq,
            other.timer_id,
        ))
    }
}

impl PartialOrd for TimerEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingMacrotask {
    trace_id: u64,
    kind: MacrotaskKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TickResult {
    pub ran_macrotask: bool,
    pub microtasks_drained: usize,
}

pub struct PiEventLoop {
    clock: ClockHandle,
    seq: u64,
    next_timer_id: u64,
    pending: VecDeque<PendingMacrotask>,
    macro_queue: BinaryHeap<std::cmp::Reverse<MacrotaskEntry>>,
    timers: BinaryHeap<std::cmp::Reverse<TimerEntry>>,
    cancelled_timers: HashSet<u64>,
}

impl PiEventLoop {
    pub fn new(clock: ClockHandle) -> Self {
        Self {
            clock,
            seq: 0,
            next_timer_id: 1,
            pending: VecDeque::new(),
            macro_queue: BinaryHeap::new(),
            timers: BinaryHeap::new(),
            cancelled_timers: HashSet::new(),
        }
    }

    pub fn enqueue_hostcall_completion(&mut self, call_id: impl Into<String>) {
        let trace_id = self.next_seq();
        self.pending.push_back(PendingMacrotask {
            trace_id,
            kind: MacrotaskKind::HostcallComplete {
                call_id: call_id.into(),
            },
        });
    }

    pub fn enqueue_inbound_event(&mut self, event_id: impl Into<String>) {
        let trace_id = self.next_seq();
        self.pending.push_back(PendingMacrotask {
            trace_id,
            kind: MacrotaskKind::InboundEvent {
                event_id: event_id.into(),
            },
        });
    }

    pub fn set_timeout(&mut self, delay_ms: u64) -> u64 {
        let timer_id = self.next_timer_id;
        self.next_timer_id += 1;
        let order_seq = self.next_seq();
        let deadline_ms = self.clock.now_ms().saturating_add(delay_ms);
        self.timers.push(std::cmp::Reverse(TimerEntry {
            deadline_ms,
            order_seq,
            timer_id,
            trace_id: order_seq,
        }));
        timer_id
    }

    pub fn clear_timeout(&mut self, timer_id: u64) {
        self.cancelled_timers.insert(timer_id);
    }

    pub fn tick(
        &mut self,
        mut on_macrotask: impl FnMut(Macrotask),
        mut drain_microtasks: impl FnMut() -> bool,
    ) -> TickResult {
        self.ingest_pending();
        self.enqueue_due_timers();

        let mut ran_macrotask = false;
        if let Some(task) = self.pop_next_macrotask() {
            ran_macrotask = true;
            on_macrotask(task);
        }

        let mut microtasks_drained = 0;
        if ran_macrotask {
            while drain_microtasks() {
                microtasks_drained += 1;
            }
        }

        TickResult {
            ran_macrotask,
            microtasks_drained,
        }
    }

    fn ingest_pending(&mut self) {
        while let Some(pending) = self.pending.pop_front() {
            self.enqueue_macrotask(pending.trace_id, pending.kind);
        }
    }

    fn enqueue_due_timers(&mut self) {
        let now = self.clock.now_ms();
        while let Some(std::cmp::Reverse(entry)) = self.timers.peek().cloned() {
            if entry.deadline_ms > now {
                break;
            }
            let _ = self.timers.pop();
            if self.cancelled_timers.remove(&entry.timer_id) {
                continue;
            }
            self.enqueue_macrotask(
                entry.trace_id,
                MacrotaskKind::TimerFired {
                    timer_id: entry.timer_id,
                },
            );
        }
    }

    fn enqueue_macrotask(&mut self, trace_id: u64, kind: MacrotaskKind) {
        let seq = self.next_seq();
        self.macro_queue.push(std::cmp::Reverse(MacrotaskEntry {
            seq,
            trace_id,
            kind,
        }));
    }

    fn pop_next_macrotask(&mut self) -> Option<Macrotask> {
        self.macro_queue.pop().map(|entry| {
            let entry = entry.0;
            Macrotask {
                seq: entry.seq,
                trace_id: entry.trace_id,
                kind: entry.kind,
            }
        })
    }

    const fn next_seq(&mut self) -> u64 {
        let current = self.seq;
        self.seq = self.seq.saturating_add(1);
        current
    }
}

fn throw_unimplemented(ctx: &Ctx<'_>, name: &str) -> rquickjs::Error {
    let message = format!("{name} is not wired yet");
    match message.into_js(ctx) {
        Ok(value) => ctx.throw(value),
        Err(err) => err,
    }
}

fn map_js_error(err: &rquickjs::Error) -> Error {
    Error::extension(format!("QuickJS: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostcall_completions_run_before_due_timers() {
        let clock = Arc::new(ManualClock::new(1_000));
        let mut loop_state = PiEventLoop::new(ClockHandle::new(clock));

        let _timer = loop_state.set_timeout(0);
        loop_state.enqueue_hostcall_completion("call-1");

        let mut seen = Vec::new();
        let result = loop_state.tick(|task| seen.push(task.kind), || false);

        assert!(result.ran_macrotask);
        assert_eq!(
            seen,
            vec![MacrotaskKind::HostcallComplete {
                call_id: "call-1".to_string()
            }]
        );
    }

    #[test]
    fn timers_order_by_deadline_then_schedule_seq() {
        let clock = Arc::new(ManualClock::new(0));
        let mut loop_state = PiEventLoop::new(ClockHandle::new(clock.clone()));

        let t1 = loop_state.set_timeout(10);
        let t2 = loop_state.set_timeout(10);
        let t3 = loop_state.set_timeout(5);
        clock.set(10);

        let mut fired = Vec::new();
        for _ in 0..3 {
            loop_state.tick(
                |task| {
                    if let MacrotaskKind::TimerFired { timer_id } = task.kind {
                        fired.push(timer_id);
                    }
                },
                || false,
            );
        }

        assert_eq!(fired, vec![t3, t1, t2]);
    }

    #[test]
    fn clear_timeout_prevents_fire() {
        let clock = Arc::new(ManualClock::new(0));
        let mut loop_state = PiEventLoop::new(ClockHandle::new(clock.clone()));

        let timer_id = loop_state.set_timeout(5);
        loop_state.clear_timeout(timer_id);
        clock.set(10);

        let mut fired = Vec::new();
        let result = loop_state.tick(
            |task| {
                if let MacrotaskKind::TimerFired { timer_id } = task.kind {
                    fired.push(timer_id);
                }
            },
            || false,
        );

        assert!(!result.ran_macrotask);
        assert!(fired.is_empty());
    }

    #[test]
    fn microtasks_drain_to_fixpoint_after_macrotask() {
        let clock = Arc::new(ManualClock::new(0));
        let mut loop_state = PiEventLoop::new(ClockHandle::new(clock));

        loop_state.enqueue_inbound_event("evt-1");

        let mut drain_calls = 0;
        let result = loop_state.tick(
            |_task| {},
            || {
                drain_calls += 1;
                drain_calls <= 2
            },
        );

        assert!(result.ran_macrotask);
        assert_eq!(result.microtasks_drained, 2);
        assert_eq!(drain_calls, 3);
    }
}
