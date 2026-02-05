/**
 * Shadow Git Extension
 *
 * Enables git-based orchestration control over subagents:
 * - Commits agent state after each tool call, turn, and agent end
 * - Captures patches when agents modify target repos
 * - Enables branching, rewinding, and forking agent execution paths
 * - Mission Control dashboard for monitoring multiple agents
 *
 * Environment Variables:
 *   PI_WORKSPACE_ROOT      - Root of the shadow git workspace (required)
 *   PI_AGENT_NAME          - Name of this agent (required for logging, optional for dashboard)
 *   PI_TARGET_REPOS        - Comma-separated target repo paths (optional)
 *   PI_TARGET_BRANCH       - Branch/worktree name agent is using in target (optional)
 *   PI_SHADOW_GIT_DISABLED - Set to "1" or "true" to disable (killswitch)
 *
 * Commands:
 *   /shadow-git           - Show status
 *   /shadow-git enable    - Enable logging
 *   /shadow-git disable   - Disable logging (killswitch)
 *   /shadow-git history   - Show recent commits
 *   /mission-control      - Open Mission Control dashboard
 *   /mc                   - Alias for mission-control
 *
 * Failure Mode: FAIL-OPEN
 *   Git commit failures are logged but do NOT block the agent.
 *   This ensures agent execution continues even if git operations fail.
 *
 * Commit Message Format:
 *   [agent:start] initialized              - When agent starts
 *   [agent:tool]  {toolName}: {brief}      - After each tool call
 *   [agent:turn]  turn {N} complete        - After each turn
 *   [agent:end]   {status}                 - When agent completes
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { registerMissionControl } from "./lib/mission-control.js";

// =============================================================================
// Types
// =============================================================================

interface Config {
	workspaceRoot: string;
	agentName: string;
	targetRepos: string[];
	targetBranch?: string;
	agentDir: string;
	auditFile: string;
	patchDir: string;
}

interface AuditEntry {
	ts: number;
	event: string;
	agent: string;
	turn: number;
	[key: string]: unknown;
}

interface AgentState {
	agent: string;
	turn: number;
	status: "running" | "done" | "error";
	toolCalls: number;
	lastTool: string | null;
	lastActivity: number;
	errors: number;
}

interface ManifestAgent {
	status: "pending" | "running" | "done" | "error";
	spawnedAt: number | null;
	completedAt: number | null;
	pid: number | null;
}

interface Manifest {
	version: 1;
	created: number;
	agents: Record<string, ManifestAgent>;
}

interface Stats {
	commits: number;
	commitErrors: number;
	toolCalls: number;
	turns: number;
	patchesCaptured: number;
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	// -------------------------------------------------------------------------
	// Configuration
	// -------------------------------------------------------------------------

	const workspaceRoot = process.env.PI_WORKSPACE_ROOT;
	const agentName = process.env.PI_AGENT_NAME;

	// Always register Mission Control (only needs PI_WORKSPACE_ROOT)
	registerMissionControl(pi);

	// Shadow-git logging needs both PI_WORKSPACE_ROOT and PI_AGENT_NAME
	if (!workspaceRoot || !agentName) {
		registerCommands(pi, null, null, { enabled: false, reason: "Not configured (missing PI_WORKSPACE_ROOT or PI_AGENT_NAME)" });
		return;
	}

	// Check initial killswitch state
	let enabled = !isKillswitchActive();

	const targetRepos = process.env.PI_TARGET_REPOS
		? process.env.PI_TARGET_REPOS.split(",").map((p) => p.trim())
		: [];

	const config: Config = {
		workspaceRoot,
		agentName,
		targetRepos,
		targetBranch: process.env.PI_TARGET_BRANCH,
		agentDir: join(workspaceRoot, "agents", agentName),
		auditFile: join(workspaceRoot, "agents", agentName, "audit.jsonl"),
		patchDir: join(workspaceRoot, "target-patches"),
	};

	// Ensure directories exist (fail-open: log error but continue)
	try {
		mkdirSync(dirname(config.auditFile), { recursive: true });
		mkdirSync(config.patchDir, { recursive: true });
	} catch (err) {
		console.error(`[shadow-git] Failed to create directories: ${err}`);
	}

	// -------------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------------

	let currentTurn = 0;
	let toolCallCount = 0;
	let lastToolName: string | null = null;
	let agentStatus: "running" | "done" | "error" = "running";

	const stats: Stats = {
		commits: 0,
		commitErrors: 0,
		toolCalls: 0,
		turns: 0,
		patchesCaptured: 0,
	};

	// Track if agent repo is initialized
	let agentRepoInitialized = false;

	/**
	 * Write state.json checkpoint file.
	 * This captures agent state for rollback/recovery.
	 */
	function writeStateCheckpoint(): void {
		const state: AgentState = {
			agent: config.agentName,
			turn: currentTurn,
			status: agentStatus,
			toolCalls: stats.toolCalls,
			lastTool: lastToolName,
			lastActivity: Date.now(),
			errors: stats.commitErrors,
		};

		try {
			const stateFile = join(config.agentDir, "state.json");
			writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
		} catch (err) {
			console.error(`[shadow-git] Failed to write state.json: ${err}`);
		}
	}

	/**
	 * Update manifest.json at workspace root.
	 * This provides a registry of all agents for orchestration.
	 */
	function updateManifest(updates: Partial<ManifestAgent>): void {
		const manifestPath = join(config.workspaceRoot, "manifest.json");

		try {
			// Read existing manifest or create new one
			let manifest: Manifest;
			if (existsSync(manifestPath)) {
				const content = require("fs").readFileSync(manifestPath, "utf-8");
				manifest = JSON.parse(content);
			} else {
				manifest = {
					version: 1,
					created: Date.now(),
					agents: {},
				};
			}

			// Update agent entry
			const existing = manifest.agents[config.agentName] || {
				status: "pending",
				spawnedAt: null,
				completedAt: null,
				pid: null,
			};

			manifest.agents[config.agentName] = { ...existing, ...updates };

			// Atomic write: write to temp file, then rename
			const tempPath = manifestPath + ".tmp";
			writeFileSync(tempPath, JSON.stringify(manifest, null, 2) + "\n");
			require("fs").renameSync(tempPath, manifestPath);
		} catch (err) {
			// Fail-open: don't block agent if manifest update fails
			console.error(`[shadow-git] Failed to update manifest: ${err}`);
		}
	}

	// -------------------------------------------------------------------------
	// Utility Functions
	// -------------------------------------------------------------------------

	/**
	 * Check for and clean up stale lock files.
	 * Lock files older than 60 seconds are considered stale.
	 */
	function cleanStaleLocks(): void {
		const lockFile = join(config.agentDir, ".git", "index.lock");
		
		if (!existsSync(lockFile)) return;

		try {
			const { statSync, unlinkSync } = require("fs");
			const stat = statSync(lockFile);
			const ageMs = Date.now() - stat.mtimeMs;
			const maxAgeMs = 60 * 1000; // 60 seconds

			if (ageMs > maxAgeMs) {
				unlinkSync(lockFile);
				emit("lock_cleaned", { file: lockFile, ageMs });
				console.log(`[shadow-git] Cleaned stale lock file (${Math.round(ageMs / 1000)}s old)`);
			} else {
				emit("lock_detected", { file: lockFile, ageMs });
				console.log(`[shadow-git] Lock file detected (${Math.round(ageMs / 1000)}s old)`);
			}
		} catch (err) {
			emit("lock_error", { file: lockFile, error: String(err) });
			console.error(`[shadow-git] Failed to check/clean lock: ${err}`);
		}
	}

	/**
	 * Initialize a git repository in the agent's directory.
	 * This gives each agent its own .git, eliminating lock conflicts.
	 * 
	 * Goedecke: "One owner, one writer" - each agent owns its own repo.
	 */
	async function initAgentRepo(): Promise<boolean> {
		const gitDir = join(config.agentDir, ".git");

		// Clean any stale locks first
		if (existsSync(gitDir)) {
			cleanStaleLocks();
		}
		
		// Already initialized
		if (existsSync(gitDir)) {
			agentRepoInitialized = true;
			return true;
		}

		try {
			// Initialize git repo in agent directory
			const init = await pi.exec("git", ["init"], { cwd: config.agentDir });
			if (init.code !== 0) {
				throw new Error(`git init failed: ${init.stderr}`);
			}

			// Create .gitignore to exclude audit.jsonl (it's for real-time, not git)
			const gitignorePath = join(config.agentDir, ".gitignore");
			writeFileSync(gitignorePath, "audit.jsonl\n");

			// Initial commit
			await pi.exec("git", ["add", ".gitignore"], { cwd: config.agentDir });
			await pi.exec("git", ["commit", "-m", "agent initialized", "--allow-empty"], { cwd: config.agentDir });

			agentRepoInitialized = true;
			emit("git_init", { agentDir: config.agentDir });
			return true;
		} catch (err) {
			// FAIL-OPEN: Log error but don't block agent
			emit("git_init_error", { error: String(err) });
			console.error(`[shadow-git] Failed to init agent repo (continuing): ${err}`);
			return false;
		}
	}

	function isKillswitchActive(): boolean {
		const val = process.env.PI_SHADOW_GIT_DISABLED;
		return val === "1" || val === "true";
	}

	function emit(event: string, data: Record<string, unknown>): void {
		if (!enabled) return;

		const entry: AuditEntry = {
			ts: Date.now(),
			event,
			agent: config.agentName,
			turn: currentTurn,
			...data,
		};

		try {
			appendFileSync(config.auditFile, JSON.stringify(entry) + "\n");
		} catch (err) {
			console.error(`[shadow-git] Failed to write audit log: ${err}`);
		}
	}

	async function gitCommitInternal(message: string): Promise<boolean> {
		// Skip if agent repo not initialized (fail-open)
		if (!agentRepoInitialized) {
			return true;
		}

		try {
			// Stage all changes in agent directory (now uses agentDir, not workspaceRoot)
			const addAgent = await pi.exec("git", ["add", "-A"], { cwd: config.agentDir });
			if (addAgent.code !== 0) {
				throw new Error(`git add failed: ${addAgent.stderr}`);
			}

			// Commit (allow empty for timeline continuity)
			const fullMessage = config.targetBranch
				? `${message} [target: ${config.targetBranch}]`
				: message;

			const commit = await pi.exec("git", [
				"commit",
				"-m",
				fullMessage,
				"--allow-empty",
			], { cwd: config.agentDir });

			if (commit.code !== 0) {
				throw new Error(`git commit failed: ${commit.stderr}`);
			}

			stats.commits++;
			return true;
		} catch (err) {
			// FAIL-OPEN: Log error but don't block agent
			stats.commitErrors++;
			emit("commit_error", { message, error: String(err) });
			console.error(`[shadow-git] Commit failed (continuing): ${err}`);
			return false;
		}
	}

	// Commit to agent's git repo (no queue needed - per-agent repos eliminate lock conflicts)
	function gitCommit(message: string): Promise<boolean> {
		if (!enabled) return Promise.resolve(true);
		return gitCommitInternal(message);
	}

	function isTargetRepoPath(filePath: string): string | null {
		const absPath = isAbsolute(filePath) ? filePath : join(process.cwd(), filePath);

		// If it's inside workspace, it's not a target repo path
		if (absPath.startsWith(config.workspaceRoot)) {
			return null;
		}

		// Check if it's in any configured target repo
		for (const repo of config.targetRepos) {
			const absRepo = isAbsolute(repo) ? repo : join(process.cwd(), repo);
			if (absPath.startsWith(absRepo)) {
				return repo;
			}
		}

		// If no target repos configured, any path outside workspace is a target
		if (config.targetRepos.length === 0 && !absPath.startsWith(config.workspaceRoot)) {
			return "unknown";
		}

		return null;
	}

	async function capturePatch(
		targetRepo: string,
		filePath: string,
		toolName: string
	): Promise<void> {
		if (!enabled) return;

		try {
			const repoName = targetRepo === "unknown"
				? "target"
				: dirname(targetRepo).split("/").pop() || "repo";
			const patchSubdir = join(config.patchDir, repoName);
			mkdirSync(patchSubdir, { recursive: true });

			const patchFile = join(
				patchSubdir,
				`turn-${String(currentTurn).padStart(3, "0")}-${toolName}-${toolCallCount}.patch`
			);

			const { stdout, code } = await pi.exec("git", [
				"-C",
				dirname(filePath),
				"diff",
				"HEAD",
				"--",
				filePath,
			]);

			if (code === 0 && stdout.trim()) {
				writeFileSync(patchFile, stdout);
				stats.patchesCaptured++;
				emit("patch_captured", { file: filePath, patch: patchFile });
			}
		} catch (err) {
			emit("patch_error", { file: filePath, error: String(err) });
			console.error(`[shadow-git] Patch capture failed: ${err}`);
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		if (!enabled) {
			ctx.ui.setStatus("shadow-git", "🔇 shadow-git: disabled");
		} else {
			const errorSuffix = stats.commitErrors > 0 ? ` ⚠️${stats.commitErrors}` : "";
			ctx.ui.setStatus("shadow-git", `📝 ${config.agentName} T${currentTurn}${errorSuffix}`);
		}
	}

	// -------------------------------------------------------------------------
	// Register Commands
	// -------------------------------------------------------------------------

	registerCommands(pi, config, stats, {
		enabled: true,
		getEnabled: () => enabled,
		setEnabled: (val: boolean, ctx: ExtensionContext) => {
			enabled = val;
			updateStatus(ctx);
			emit(val ? "enabled" : "disabled", {});
		},
	});

	// -------------------------------------------------------------------------
	// Session Lifecycle Events
	// -------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Re-check killswitch on session start (env may have changed)
		if (isKillswitchActive()) {
			enabled = false;
		}

		updateStatus(ctx);

		if (!enabled) return;

		// Initialize per-agent git repo (Goedecke: "one owner, one writer")
		await initAgentRepo();

		// Register in manifest
		updateManifest({
			status: "running",
			spawnedAt: Date.now(),
			pid: process.pid,
		});

		emit("session_start", {});
		await gitCommit(`[${config.agentName}:start] session began`);
	});

	pi.on("session_shutdown", async () => {
		// Update manifest even if disabled
		updateManifest({
			status: agentStatus,
			completedAt: Date.now(),
		});

		if (!enabled) return;

		emit("session_shutdown", { stats });
		// NOTE: No commit here - turn_end commits capture state
		// Stats are preserved in audit.jsonl
	});

	// -------------------------------------------------------------------------
	// Agent Events
	// -------------------------------------------------------------------------

	pi.on("agent_end", async (event) => {
		agentStatus = "done";

		if (!enabled) return;

		emit("agent_end", { messageCount: event.messages.length, stats });
		// NOTE: No commit here - agent_end fires BEFORE final turn_end
		// which causes confusing commit order. Turn commits are sufficient.
		// Final state is captured in state.json during turn_end.
	});

	// -------------------------------------------------------------------------
	// Turn Events
	// -------------------------------------------------------------------------

	pi.on("turn_start", async (event, ctx) => {
		currentTurn = event.turnIndex;
		stats.turns++;
		updateStatus(ctx);

		if (!enabled) return;

		emit("turn_start", { turn: event.turnIndex });
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!enabled) return;

		const toolCount = event.toolResults.length;

		emit("turn_end", {
			turn: event.turnIndex,
			toolResultCount: toolCount,
		});

		// Write state checkpoint before git commit
		writeStateCheckpoint();

		// Turn-level commits (Goedecke: "Complexity is debt" - 10x fewer commits)
		// Summary includes tool count for meaningful checkpoints
		const summary = toolCount > 0 ? `${toolCount} tools` : "no tools";
		await gitCommit(`[${config.agentName}:turn-${event.turnIndex}] ${summary}`);
		updateStatus(ctx);
	});

	// -------------------------------------------------------------------------
	// Tool Events
	// -------------------------------------------------------------------------

	pi.on("tool_call", async (event) => {
		toolCallCount++;
		stats.toolCalls++;
		lastToolName = event.toolName;

		if (!enabled) return;

		emit("tool_call", {
			tool: event.toolName,
			toolCallId: event.toolCallId,
			input: event.input,
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;

		emit("tool_result", {
			tool: event.toolName,
			toolCallId: event.toolCallId,
			error: event.isError,
		});

		// Capture patches for write/edit operations on target repos
		if (event.toolName === "write" || event.toolName === "edit") {
			const filePath = event.input.path as string;
			const targetRepo = isTargetRepoPath(filePath);

			if (targetRepo) {
				await capturePatch(targetRepo, filePath, event.toolName);
			}
		}

		// NOTE: Per-tool commits REMOVED (Goedecke: "Complexity is debt")
		// Commits now happen at turn_end only - see turn_end handler
		// Tool-level granularity is preserved in audit.jsonl
		updateStatus(ctx);
	});
}

// =============================================================================
// Command Registration (separated for reuse in unconfigured mode)
// =============================================================================

interface CommandState {
	enabled: boolean;
	reason?: string;
	getEnabled?: () => boolean;
	setEnabled?: (val: boolean, ctx: ExtensionContext) => void;
}

function registerCommands(
	pi: ExtensionAPI,
	config: Config | null,
	stats: Stats | null,
	state: CommandState
): void {
	pi.registerCommand("shadow-git", {
		description: "Shadow-git status and control (enable|disable|history|stats)",
		handler: async (args, ctx) => {
			const subcommand = args.trim().split(/\s+/)[0] || "status";

			// Handle unconfigured state
			if (!config || !stats) {
				if (ctx.hasUI) {
					ctx.ui.notify(`shadow-git: ${state.reason || "not configured"}`, "warning");
				}
				return;
			}

			switch (subcommand) {
				case "status": {
					const enabled = state.getEnabled?.() ?? state.enabled;
					const lines = [
						`Shadow-Git Status`,
						`─────────────────`,
						`Enabled:    ${enabled ? "✅ yes" : "❌ no (killswitch)"}`,
						`Agent:      ${config.agentName}`,
						`Workspace:  ${config.workspaceRoot}`,
						`Turn:       ${stats.turns}`,
						`Commits:    ${stats.commits}`,
						`Errors:     ${stats.commitErrors}`,
						`Patches:    ${stats.patchesCaptured}`,
						`Audit:      ${config.auditFile}`,
					];
					if (ctx.hasUI) {
						await ctx.ui.select("Shadow-Git Status", lines);
					}
					break;
				}

				case "enable": {
					state.setEnabled?.(true, ctx);
					if (ctx.hasUI) {
						ctx.ui.notify("shadow-git enabled", "success");
					}
					break;
				}

				case "disable": {
					state.setEnabled?.(false, ctx);
					if (ctx.hasUI) {
						ctx.ui.notify("shadow-git disabled (killswitch active)", "warning");
					}
					break;
				}

				case "history": {
					const { stdout, code } = await pi.exec("git", [
						"log",
						"--oneline",
						"-20",
					], { cwd: config.agentDir });

					if (code === 0 && stdout.trim()) {
						const lines = stdout.trim().split("\n");
						if (ctx.hasUI) {
							await ctx.ui.select("Recent Commits (last 20)", lines);
						}
					} else if (ctx.hasUI) {
						ctx.ui.notify("No commits found or git error", "warning");
					}
					break;
				}

				case "stats": {
					const lines = [
						`Commits:         ${stats.commits}`,
						`Commit errors:   ${stats.commitErrors}`,
						`Tool calls:      ${stats.toolCalls}`,
						`Turns:           ${stats.turns}`,
						`Patches:         ${stats.patchesCaptured}`,
					];
					if (ctx.hasUI) {
						await ctx.ui.select("Shadow-Git Stats", lines);
					}
					break;
				}

				case "rollback": {
					// Usage: /shadow-git rollback <turn>
					const turnArg = args.trim().split(/\s+/)[1];
					if (!turnArg) {
						if (ctx.hasUI) {
							ctx.ui.notify("Usage: /shadow-git rollback <turn>", "warning");
						}
						break;
					}

					const targetTurn = parseInt(turnArg, 10);
					if (isNaN(targetTurn)) {
						if (ctx.hasUI) {
							ctx.ui.notify(`Invalid turn number: ${turnArg}`, "warning");
						}
						break;
					}

					// Find commit for target turn
					const { stdout: logOutput } = await pi.exec("git", [
						"log",
						"--oneline",
						"--grep",
						`:turn-${targetTurn}]`,
					], { cwd: config.agentDir });

					if (!logOutput.trim()) {
						if (ctx.hasUI) {
							ctx.ui.notify(`No commit found for turn ${targetTurn}`, "warning");
						}
						break;
					}

					const commitHash = logOutput.trim().split(" ")[0];
					
					// Reset to that commit
					const { code } = await pi.exec("git", [
						"reset",
						"--hard",
						commitHash,
					], { cwd: config.agentDir });

					if (code === 0) {
						if (ctx.hasUI) {
							ctx.ui.notify(`Rolled back to turn ${targetTurn} (${commitHash})`, "success");
						}
					} else {
						if (ctx.hasUI) {
							ctx.ui.notify(`Rollback failed`, "warning");
						}
					}
					break;
				}

				case "branch": {
					// Usage: /shadow-git branch <name> [from-turn]
					const branchArgs = args.trim().split(/\s+/).slice(1);
					const branchName = branchArgs[0];
					const fromTurn = branchArgs[1] ? parseInt(branchArgs[1], 10) : undefined;

					if (!branchName) {
						if (ctx.hasUI) {
							ctx.ui.notify("Usage: /shadow-git branch <name> [from-turn]", "warning");
						}
						break;
					}

					// If from-turn specified, checkout that commit first
					if (fromTurn !== undefined && !isNaN(fromTurn)) {
						const { stdout: logOutput } = await pi.exec("git", [
							"log",
							"--oneline",
							"--grep",
							`:turn-${fromTurn}]`,
						], { cwd: config.agentDir });

						if (logOutput.trim()) {
							const commitHash = logOutput.trim().split(" ")[0];
							await pi.exec("git", ["checkout", commitHash], { cwd: config.agentDir });
						}
					}

					// Create new branch
					const { code } = await pi.exec("git", [
						"checkout",
						"-b",
						branchName,
					], { cwd: config.agentDir });

					if (code === 0) {
						if (ctx.hasUI) {
							ctx.ui.notify(`Created branch '${branchName}'`, "success");
						}
					} else {
						if (ctx.hasUI) {
							ctx.ui.notify(`Failed to create branch`, "warning");
						}
					}
					break;
				}

				case "branches": {
					// List branches
					const { stdout } = await pi.exec("git", [
						"branch",
						"-a",
					], { cwd: config.agentDir });

					if (stdout.trim()) {
						const lines = stdout.trim().split("\n");
						if (ctx.hasUI) {
							await ctx.ui.select("Branches", lines);
						}
					} else if (ctx.hasUI) {
						ctx.ui.notify("No branches found", "warning");
					}
					break;
				}

				default: {
					if (ctx.hasUI) {
						ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use: status|enable|disable|history|stats|rollback|branch|branches`, "warning");
					}
				}
			}
		},
	});
}
