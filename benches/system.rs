//! System-level benchmarks: startup time, memory usage, binary size.
//!
// Allow some clippy lints that are acceptable in benchmarks
#![allow(clippy::cast_precision_loss)] // u64 -> f64 for size calculations is fine
#![allow(clippy::cmp_owned)] // PathBuf comparison with "pi" requires owned
//!
//! Run with:
//! - `cargo bench --bench system`
//! - `cargo bench startup`
//! - `cargo bench memory`
//!
//! These benchmarks measure real-world performance by spawning the actual binary.
//! They complement the micro-benchmarks in tools.rs and extensions.rs.
//!
//! Performance budgets:
//! - Startup time (--version): <100ms (p95), 11.2ms typical
//! - Startup time (cold, full agent): <200ms (p95)
//! - Idle memory: <50MB RSS
//! - Binary size (release): <20MB

use std::env;
use std::hint::black_box;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use sha2::{Digest, Sha256};
use sysinfo::{ProcessRefreshKind, RefreshKind, System};

// ============================================================================
// Environment Banner
// ============================================================================

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn print_system_banner_once() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let mut system = System::new();
        system.refresh_cpu_all();
        system.refresh_memory();

        let cpu_brand = system
            .cpus()
            .first()
            .map_or_else(|| "unknown".to_string(), |cpu| cpu.brand().to_string());

        let config = format!(
            "pkg={} git_sha={} build_ts={}",
            env!("CARGO_PKG_VERSION"),
            option_env!("VERGEN_GIT_SHA").unwrap_or("unknown"),
            option_env!("VERGEN_BUILD_TIMESTAMP").unwrap_or(""),
        );
        let config_hash = sha256_hex(&config);

        eprintln!(
            "[bench-env] os={} arch={} cpu=\"{}\" cores={} mem_total_mb={} config_hash={}",
            System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string()),
            std::env::consts::ARCH,
            cpu_brand,
            system.cpus().len(),
            system.total_memory() / 1024 / 1024,
            config_hash
        );
    });
}

fn criterion_config() -> Criterion {
    print_system_banner_once();
    Criterion::default()
        .sample_size(20) // Fewer samples for process spawn benchmarks
        .measurement_time(Duration::from_secs(10))
}

// ============================================================================
// Binary Path Resolution
// ============================================================================

fn pi_binary_path() -> PathBuf {
    // Check for explicit override
    if let Ok(path) = env::var("PI_BENCH_BINARY") {
        return PathBuf::from(path);
    }

    // Look for release binary first (more realistic)
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let release_path = manifest_dir.join("target/release/pi");
    if release_path.exists() {
        return release_path;
    }

    // Fall back to debug binary
    let debug_path = manifest_dir.join("target/debug/pi");
    if debug_path.exists() {
        return debug_path;
    }

    // Last resort: hope it's in PATH
    PathBuf::from("pi")
}

fn binary_size_bytes() -> Option<u64> {
    let path = pi_binary_path();
    std::fs::metadata(&path).ok().map(|m| m.len())
}

// ============================================================================
// Startup Time Benchmarks
// ============================================================================

/// Measure startup time for `pi --version` (minimal startup path)
fn bench_startup_version(c: &mut Criterion) {
    let binary = pi_binary_path();
    if !binary.exists() && binary != PathBuf::from("pi") {
        eprintln!(
            "[skip] bench_startup_version: binary not found at {}",
            binary.display()
        );
        return;
    }

    {
        let mut group = c.benchmark_group("startup");

        // Warm the filesystem cache
        for _ in 0..3 {
            let _ = Command::new(&binary)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }

        group.bench_function(BenchmarkId::new("version", "warm"), |b| {
            b.iter(|| {
                let start = Instant::now();
                let status = Command::new(&binary)
                    .arg("--version")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .expect("failed to execute pi");
                let elapsed = start.elapsed();
                assert!(status.success(), "pi --version failed");
                black_box(elapsed)
            });
        });

        group.finish();
    }

    // Log binary size for reference
    if let Some(size) = binary_size_bytes() {
        let size_mb = size as f64 / 1024.0 / 1024.0;
        eprintln!(
            "[info] binary_size={size_mb:.2}MB path={}",
            binary.display()
        );
    }
}

/// Measure startup time for `pi --help` (loads more code paths)
fn bench_startup_help(c: &mut Criterion) {
    let binary = pi_binary_path();
    if !binary.exists() && binary != PathBuf::from("pi") {
        eprintln!(
            "[skip] bench_startup_help: binary not found at {}",
            binary.display()
        );
        return;
    }

    {
        let mut group = c.benchmark_group("startup");

        // Warm the filesystem cache
        for _ in 0..3 {
            let _ = Command::new(&binary)
                .arg("--help")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }

        group.bench_function(BenchmarkId::new("help", "warm"), |b| {
            b.iter(|| {
                let start = Instant::now();
                let status = Command::new(&binary)
                    .arg("--help")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .expect("failed to execute pi");
                let elapsed = start.elapsed();
                assert!(status.success(), "pi --help failed");
                black_box(elapsed)
            });
        });

        group.finish();
    }
}

/// Measure startup time for `pi --list-models` (exercises provider listing)
fn bench_startup_list_models(c: &mut Criterion) {
    let binary = pi_binary_path();
    if !binary.exists() && binary != PathBuf::from("pi") {
        eprintln!(
            "[skip] bench_startup_list_models: binary not found at {}",
            binary.display()
        );
        return;
    }

    {
        let mut group = c.benchmark_group("startup");

        // Warm the filesystem cache
        for _ in 0..3 {
            let _ = Command::new(&binary)
                .arg("--list-models")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }

        group.bench_function(BenchmarkId::new("list_models", "warm"), |b| {
            b.iter(|| {
                let start = Instant::now();
                let status = Command::new(&binary)
                    .arg("--list-models")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .expect("failed to execute pi");
                let elapsed = start.elapsed();
                // list-models may fail without API key, just measure time
                black_box((elapsed, status))
            });
        });

        group.finish();
    }
}

// ============================================================================
// Memory Benchmarks
// ============================================================================

/// Measure RSS memory for `pi --version` (process exits immediately)
fn bench_memory_version(c: &mut Criterion) {
    let binary = pi_binary_path();
    if !binary.exists() && binary != PathBuf::from("pi") {
        eprintln!(
            "[skip] bench_memory_version: binary not found at {}",
            binary.display()
        );
        return;
    }

    let mut group = c.benchmark_group("memory");

    group.bench_function(BenchmarkId::new("version_peak", "spawn"), |b| {
        b.iter(|| {
            // Spawn process and immediately query its memory
            let mut child = Command::new(&binary)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("failed to spawn pi");

            let pid = sysinfo::Pid::from_u32(child.id());
            let mut system = System::new_with_specifics(
                RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().with_memory()),
            );
            system.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&[pid]),
                true,
                ProcessRefreshKind::nothing().with_memory(),
            );

            let memory_kb = system.process(pid).map_or(0, |p| p.memory() / 1024);

            // Wait for completion
            let _ = child.wait();

            black_box(memory_kb)
        });
    });

    group.finish();
}

// ============================================================================
// Binary Size Benchmark
// ============================================================================

/// Report binary size (not a timing benchmark, just records the value)
fn bench_binary_size(c: &mut Criterion) {
    let mut group = c.benchmark_group("binary");

    if let Some(size) = binary_size_bytes() {
        let size_mb = size as f64 / 1024.0 / 1024.0;
        eprintln!("[metric] binary_size_mb={size_mb:.2}");

        // Check against budget
        let budget_mb = 20.0;
        if size_mb > budget_mb {
            eprintln!("[WARN] binary size {size_mb:.2}MB exceeds budget {budget_mb:.2}MB");
        } else {
            eprintln!("[OK] binary size {size_mb:.2}MB within budget {budget_mb:.2}MB");
        }

        // "Benchmark" that just records the size for criterion tracking
        group.bench_function("size_mb", |b| {
            b.iter(|| black_box(size_mb));
        });
    } else {
        eprintln!("[skip] bench_binary_size: could not read binary");
    }

    group.finish();
}

// ============================================================================
// Criterion Groups
// ============================================================================

criterion_group!(
    name = benches;
    config = criterion_config();
    targets =
        bench_startup_version,
        bench_startup_help,
        bench_startup_list_models,
        bench_memory_version,
        bench_binary_size
);
criterion_main!(benches);
