/**
 * Mission Control - Real-time dashboard for monitoring multiple pi agents
 *
 * Provides a TUI overlay showing:
 * - All agents and their status (running, done, error, pending)
 * - Turn count, tool calls, errors per agent
 * - Real-time updates via audit.jsonl parsing
 * - Scrollable list for 100s of agents
 *
 * Usage:
 *   /mission-control                - Open dashboard
 *   /mc                             - Alias
 *
 * Environment:
 *   PI_WORKSPACE_ROOT               - Root of shadow git workspace (required)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth, type Theme } from "@mariozechner/pi-tui";

// =============================================================================
// Types
// =============================================================================

interface AgentStatus {
	name: string;
	status: "running" | "done" | "error" | "pending";
	turns: number;
	toolCalls: number;
	errors: number;
	lastEvent: string;
	lastActivity: number;
	duration: number;
	startTime: number | null;
	endTime: number | null;
	recentErrors: string[];  // Last few error messages
	lastTools: string[];     // Last few tool calls for context
}

interface DashboardState {
	agents: AgentStatus[];
	selectedIndex: number;
	scrollOffset: number;
	sortBy: "name" | "status" | "activity";
	showDetails: boolean;
	lastRefresh: number;
}

// =============================================================================
// Audit Log Parser
// =============================================================================

function parseAuditLog(auditPath: string): Partial<AgentStatus> {
	if (!existsSync(auditPath)) {
		return { status: "pending", turns: 0, toolCalls: 0, errors: 0, recentErrors: [], lastTools: [] };
	}

	const content = readFileSync(auditPath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);

	let turns = 0;
	let toolCalls = 0;
	let errors = 0;
	let lastEvent = "";
	let lastActivity = 0;
	let startTime: number | null = null;
	let endTime: number | null = null;
	let status: AgentStatus["status"] = "pending";
	const recentErrors: string[] = [];
	const lastTools: string[] = [];

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			const ts = entry.ts || 0;

			if (ts > lastActivity) {
				lastActivity = ts;
				lastEvent = entry.event || "";
			}

			switch (entry.event) {
				case "session_start":
					if (!startTime) startTime = ts;
					status = "running";
					break;
				case "turn_end":
					turns++;
					break;
				case "tool_call":
					toolCalls++;
					// Track last few tool calls for context
					const toolInfo = `${entry.tool || "?"}`;
					const inputBrief = entry.input?.path || entry.input?.command?.slice(0, 30) || "";
					lastTools.push(`${toolInfo}: ${inputBrief}`.slice(0, 50));
					if (lastTools.length > 5) lastTools.shift();
					break;
				case "tool_result":
					if (entry.error) {
						errors++;
						// Capture error details
						const tool = entry.tool || "unknown";
						const errMsg = `[T${entry.turn || "?"}] ${tool} failed`;
						recentErrors.push(errMsg);
						if (recentErrors.length > 5) recentErrors.shift();
					}
					break;
				case "commit_error":
					errors++;
					// Extract the key part of the error message
					let commitErr = String(entry.error || entry.message || "git commit failed");
					// Clean up common git errors
					if (commitErr.includes("index.lock")) {
						commitErr = "git lock conflict (another agent using repo)";
					} else if (commitErr.includes("git add failed")) {
						commitErr = "git add failed";
					} else if (commitErr.includes("git commit failed")) {
						commitErr = "git commit failed";
					} else {
						commitErr = commitErr.split("\n")[0].slice(0, 60);
					}
					recentErrors.push(`[T${entry.turn || "?"}] ${commitErr}`);
					if (recentErrors.length > 5) recentErrors.shift();
					break;
				case "agent_end":
				case "session_shutdown":
					endTime = ts;
					status = errors > 0 ? "error" : "done";
					break;
			}
		} catch {
			// Skip malformed lines
		}
	}

	// If we have activity but no end event, still running
	if (lastActivity > 0 && !endTime) {
		status = "running";
	}

	return {
		status,
		turns,
		toolCalls,
		errors,
		lastEvent,
		lastActivity,
		startTime,
		endTime,
		recentErrors,
		lastTools,
	};
}

function discoverAgents(workspaceRoot: string): AgentStatus[] {
	const agentsDir = join(workspaceRoot, "agents");
	const manifestPath = join(workspaceRoot, "manifest.json");

	// Try to read agent list from manifest first (faster for large workspaces)
	let manifestAgents: Set<string> | null = null;
	if (existsSync(manifestPath)) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
			if (manifest.agents) {
				manifestAgents = new Set(Object.keys(manifest.agents));
			}
		} catch {
			// Ignore manifest parse errors, fall back to filesystem scan
		}
	}

	if (!existsSync(agentsDir)) return [];

	const agents: AgentStatus[] = [];
	const entries = readdirSync(agentsDir);

	for (const name of entries) {
		const agentDir = join(agentsDir, name);
		if (!statSync(agentDir).isDirectory()) continue;

		// If manifest exists, only include agents listed in it
		// (allows for cleanup/hiding agents without deleting dirs)
		// Fallback: include all directories if no manifest
		if (manifestAgents && !manifestAgents.has(name)) continue;

		const auditPath = join(agentDir, "audit.jsonl");
		const parsed = parseAuditLog(auditPath);

		const startTime = parsed.startTime || null;
		const endTime = parsed.endTime || null;
		const duration = startTime
			? (endTime || Date.now()) - startTime
			: 0;

		agents.push({
			name,
			status: parsed.status || "pending",
			turns: parsed.turns || 0,
			toolCalls: parsed.toolCalls || 0,
			errors: parsed.errors || 0,
			lastEvent: parsed.lastEvent || "",
			lastActivity: parsed.lastActivity || 0,
			startTime,
			endTime,
			duration,
			recentErrors: parsed.recentErrors || [],
			lastTools: parsed.lastTools || [],
		});
	}

	return agents;
}

// =============================================================================
// Dashboard Component
// =============================================================================

class MissionControlComponent {
	private state: DashboardState;
	private workspaceRoot: string;
	private interval: ReturnType<typeof setInterval> | null = null;
	private tui: { requestRender: () => void };
	private theme: Theme;
	private onClose: () => void;
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private version = 0;
	private cachedVersion = -1;

	constructor(
		workspaceRoot: string,
		tui: { requestRender: () => void },
		theme: Theme,
		onClose: () => void
	) {
		this.workspaceRoot = workspaceRoot;
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;

		this.state = {
			agents: [],
			selectedIndex: 0,
			scrollOffset: 0,
			sortBy: "status",
			showDetails: false,
			lastRefresh: Date.now(),
		};

		this.refresh();
		this.startAutoRefresh();
	}

	private startAutoRefresh(): void {
		this.interval = setInterval(() => {
			this.refresh();
			this.version++;
			this.tui.requestRender();
		}, 2000); // Refresh every 2 seconds
	}

	private stopAutoRefresh(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private refresh(): void {
		const agents = discoverAgents(this.workspaceRoot);
		this.sortAgents(agents);
		this.state.agents = agents;
		this.state.lastRefresh = Date.now();

		// Clamp selection
		if (this.state.selectedIndex >= agents.length) {
			this.state.selectedIndex = Math.max(0, agents.length - 1);
		}
	}

	private sortAgents(agents: AgentStatus[]): void {
		const statusOrder = { running: 0, error: 1, pending: 2, done: 3 };

		switch (this.state.sortBy) {
			case "status":
				agents.sort((a, b) => {
					const statusDiff = statusOrder[a.status] - statusOrder[b.status];
					if (statusDiff !== 0) return statusDiff;
					return b.lastActivity - a.lastActivity;
				});
				break;
			case "activity":
				agents.sort((a, b) => b.lastActivity - a.lastActivity);
				break;
			case "name":
				agents.sort((a, b) => a.name.localeCompare(b.name));
				break;
		}
	}

	handleInput(data: string): void {
		const agents = this.state.agents;

		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.dispose();
			this.onClose();
			return;
		}

		if (matchesKey(data, "up") || data === "k" || data === "K") {
			if (this.state.selectedIndex > 0) {
				this.state.selectedIndex--;
				this.adjustScroll();
			}
		} else if (matchesKey(data, "down") || data === "j" || data === "J") {
			if (this.state.selectedIndex < agents.length - 1) {
				this.state.selectedIndex++;
				this.adjustScroll();
			}
		} else if (data === "r" || data === "R") {
			this.refresh();
		} else if (data === "s" || data === "S") {
			// Cycle sort
			const sorts: Array<"status" | "activity" | "name"> = ["status", "activity", "name"];
			const idx = sorts.indexOf(this.state.sortBy);
			this.state.sortBy = sorts[(idx + 1) % sorts.length];
			this.sortAgents(this.state.agents);
		} else if (matchesKey(data, "return") || data === " ") {
			this.state.showDetails = !this.state.showDetails;
		}

		this.version++;
		this.tui.requestRender();
	}

	private adjustScroll(): void {
		const visibleRows = 15; // Approximate visible rows
		if (this.state.selectedIndex < this.state.scrollOffset) {
			this.state.scrollOffset = this.state.selectedIndex;
		} else if (this.state.selectedIndex >= this.state.scrollOffset + visibleRows) {
			this.state.scrollOffset = this.state.selectedIndex - visibleRows + 1;
		}
	}

	render(width: number): string[] {
		if (this.cachedVersion === this.version && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const theme = this.theme;
		const agents = this.state.agents;

		// Header
		lines.push(this.pad(theme.bold("╔══════════════════════════════════════════════════════════════╗"), width));
		lines.push(this.pad(theme.bold("║") + "              🚀 " + theme.fg("accent", "MISSION CONTROL") + "              " + theme.bold("║"), width));
		lines.push(this.pad(theme.bold("╚══════════════════════════════════════════════════════════════╝"), width));
		lines.push("");

		// Stats summary
		const running = agents.filter((a) => a.status === "running").length;
		const done = agents.filter((a) => a.status === "done").length;
		const errors = agents.filter((a) => a.status === "error").length;
		const pending = agents.filter((a) => a.status === "pending").length;

		const statsLine = [
			theme.fg("success", `● ${running} running`),
			theme.fg("dim", `○ ${pending} pending`),
			theme.fg("accent", `✓ ${done} done`),
			theme.fg("error", `✗ ${errors} errors`),
		].join("  │  ");

		lines.push(this.pad(`  ${statsLine}`, width));
		lines.push(this.pad(theme.fg("dim", `  Sort: ${this.state.sortBy} │ Last refresh: ${this.formatTime(this.state.lastRefresh)}`), width));
		lines.push("");

		// Column headers
		const headerLine = theme.fg("muted", "  ST  AGENT                TURN  TOOLS  ERR   LAST ACTIVITY");
		lines.push(this.pad(headerLine, width));
		lines.push(this.pad(theme.fg("dim", "  " + "─".repeat(60)), width));

		// Agent list
		if (agents.length === 0) {
			lines.push(this.pad(theme.fg("warning", "  No agents found in workspace"), width));
		} else {
			const visibleRows = 12;
			const start = this.state.scrollOffset;
			const end = Math.min(start + visibleRows, agents.length);

			for (let i = start; i < end; i++) {
				const agent = agents[i];
				const selected = i === this.state.selectedIndex;
				const line = this.renderAgentLine(agent, selected, width);
				lines.push(line);
			}

			// Scroll indicator
			if (agents.length > visibleRows) {
				const scrollPct = Math.round((this.state.scrollOffset / (agents.length - visibleRows)) * 100);
				lines.push(this.pad(theme.fg("dim", `  ↕ ${this.state.scrollOffset + 1}-${end} of ${agents.length} (${scrollPct}%)`), width));
			}
		}

		lines.push("");

		// Details panel (if showing)
		if (this.state.showDetails && agents.length > 0) {
			const agent = agents[this.state.selectedIndex];
			lines.push(this.pad(theme.fg("accent", "  ┌─ Details: " + agent.name + " ─" + "─".repeat(Math.max(0, 40 - agent.name.length)) + "┐"), width));
			lines.push(this.pad(`    Status:     ${this.statusIcon(agent.status)} ${agent.status}`, width));
			lines.push(this.pad(`    Turns:      ${agent.turns}`, width));
			lines.push(this.pad(`    Tool calls: ${agent.toolCalls}`, width));
			lines.push(this.pad(`    Errors:     ${agent.errors}`, width));
			lines.push(this.pad(`    Duration:   ${this.formatDuration(agent.duration)}`, width));
			lines.push(this.pad(`    Last event: ${agent.lastEvent || "none"}`, width));
			
			// Show recent tool calls
			if (agent.lastTools.length > 0) {
				lines.push(this.pad(theme.fg("muted", "    ─── Recent Tools ───"), width));
				for (const tool of agent.lastTools.slice(-3)) {
					lines.push(this.pad(theme.fg("dim", `      ${tool}`), width));
				}
			}
			
			// Show recent errors (verbose!)
			if (agent.recentErrors.length > 0) {
				lines.push(this.pad(theme.fg("error", "    ─── Errors ───"), width));
				for (const err of agent.recentErrors) {
					lines.push(this.pad(theme.fg("error", `      ✗ ${err}`), width));
				}
			}
			
			lines.push(this.pad(theme.fg("accent", "  └" + "─".repeat(50) + "┘"), width));
			lines.push("");
		}

		// Help
		lines.push(this.pad(theme.fg("dim", "  ↑↓/jk navigate │ enter details │ s sort │ r refresh │ q/esc quit"), width));

		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;

		return lines;
	}

	private renderAgentLine(agent: AgentStatus, selected: boolean, width: number): string {
		const theme = this.theme;
		const icon = this.statusIcon(agent.status);

		const name = truncateToWidth(agent.name, 18).padEnd(18);
		const turns = String(agent.turns).padStart(4);
		const tools = String(agent.toolCalls).padStart(5);
		const errors = String(agent.errors).padStart(4);
		const activity = this.formatRelativeTime(agent.lastActivity);

		let line = `  ${icon}  ${name}  ${turns}  ${tools}  ${errors}   ${activity}`;

		if (selected) {
			line = theme.bg("selectedBg", theme.fg("accent", "▶" + line.slice(1)));
		}

		return this.pad(line, width);
	}

	private statusIcon(status: AgentStatus["status"]): string {
		const theme = this.theme;
		switch (status) {
			case "running":
				return theme.fg("success", "●");
			case "done":
				return theme.fg("accent", "✓");
			case "error":
				return theme.fg("error", "✗");
			case "pending":
				return theme.fg("dim", "○");
		}
	}

	private formatTime(ts: number): string {
		return new Date(ts).toLocaleTimeString();
	}

	private formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const secs = seconds % 60;
		if (minutes < 60) return `${minutes}m ${secs}s`;
		const hours = Math.floor(minutes / 60);
		const mins = minutes % 60;
		return `${hours}h ${mins}m`;
	}

	private formatRelativeTime(ts: number): string {
		if (!ts) return "never";
		const diff = Date.now() - ts;
		if (diff < 5000) return "just now";
		if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
		return `${Math.floor(diff / 3600000)}h ago`;
	}

	private pad(line: string, width: number): string {
		const truncated = truncateToWidth(line, width);
		const padding = Math.max(0, width - visibleWidth(truncated));
		return truncated + " ".repeat(padding);
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.cachedVersion = -1;
	}

	dispose(): void {
		this.stopAutoRefresh();
	}
}

// =============================================================================
// Compact Status Widget (shows above editor)
// =============================================================================

class StatusWidget {
	private workspaceRoot: string;
	private interval: ReturnType<typeof setInterval> | null = null;
	private cachedLines: string[] = [];
	private onUpdate: () => void;

	constructor(workspaceRoot: string, onUpdate: () => void) {
		this.workspaceRoot = workspaceRoot;
		this.onUpdate = onUpdate;
		this.refresh();
		this.startAutoRefresh();
	}

	private startAutoRefresh(): void {
		this.interval = setInterval(() => {
			this.refresh();
			this.onUpdate();
		}, 3000); // Refresh every 3 seconds
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private refresh(): void {
		const agents = discoverAgents(this.workspaceRoot);
		const running = agents.filter((a) => a.status === "running");
		const done = agents.filter((a) => a.status === "done").length;
		const errors = agents.filter((a) => a.status === "error").length;
		const pending = agents.filter((a) => a.status === "pending").length;

		// Build compact status line
		const parts: string[] = [];
		
		if (running.length > 0) {
			const runningNames = running.slice(0, 3).map((a) => a.name).join(", ");
			const more = running.length > 3 ? ` +${running.length - 3}` : "";
			parts.push(`\x1b[32m● ${running.length} running\x1b[0m (${runningNames}${more})`);
		}
		if (pending > 0) parts.push(`\x1b[2m○ ${pending} pending\x1b[0m`);
		if (done > 0) parts.push(`\x1b[36m✓ ${done} done\x1b[0m`);
		if (errors > 0) parts.push(`\x1b[31m✗ ${errors} errors\x1b[0m`);

		if (parts.length === 0) {
			this.cachedLines = ["\x1b[2m🚀 Mission Control: No agents\x1b[0m"];
		} else {
			this.cachedLines = [`\x1b[1m🚀 Mission Control:\x1b[0m ${parts.join(" │ ")}`];
		}
	}

	render(): string[] {
		return this.cachedLines;
	}

	invalidate(): void {
		this.refresh();
	}
}

// =============================================================================
// Extension Registration
// =============================================================================

export function registerMissionControl(pi: ExtensionAPI): void {
	const workspaceRoot = process.env.PI_WORKSPACE_ROOT;
	let widgetInstance: StatusWidget | null = null;
	let widgetEnabled = false;

	// -------------------------------------------------------------------------
	// Open full dashboard (blocking)
	// -------------------------------------------------------------------------
	const openDashboard = async (_args: string, ctx: ExtensionContext) => {
		if (!workspaceRoot) {
			if (ctx.hasUI) {
				ctx.ui.notify("PI_WORKSPACE_ROOT not set", "error");
			}
			return;
		}

		if (!ctx.hasUI) {
			// Non-interactive: just print status
			const agents = discoverAgents(workspaceRoot);
			const running = agents.filter((a) => a.status === "running").length;
			const done = agents.filter((a) => a.status === "done").length;
			const errors = agents.filter((a) => a.status === "error").length;
			console.log(`Agents: ${agents.length} total, ${running} running, ${done} done, ${errors} errors`);
			return;
		}

		await ctx.ui.custom((tui, theme, _kb, done) => {
			const component = new MissionControlComponent(
				workspaceRoot,
				tui,
				theme,
				() => done(undefined)
			);
			return component;
		});
	};

	// -------------------------------------------------------------------------
	// Widget control (persistent status above editor)
	// -------------------------------------------------------------------------
	const enableWidget = (ctx: ExtensionContext) => {
		if (!workspaceRoot || !ctx.hasUI) return;
		if (widgetEnabled) return;

		widgetInstance = new StatusWidget(workspaceRoot, () => {
			// Force TUI refresh by re-setting widget
			if (widgetInstance && ctx.hasUI) {
				ctx.ui.setWidget("mission-control", () => ({
					render: () => widgetInstance!.render(),
					invalidate: () => widgetInstance!.invalidate(),
				}));
			}
		});

		ctx.ui.setWidget("mission-control", () => ({
			render: () => widgetInstance!.render(),
			invalidate: () => widgetInstance!.invalidate(),
		}));

		widgetEnabled = true;
		ctx.ui.notify("Mission Control widget enabled (Ctrl+Shift+M to toggle)", "info");
	};

	const disableWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!widgetEnabled) return;

		if (widgetInstance) {
			widgetInstance.stop();
			widgetInstance = null;
		}

		ctx.ui.setWidget("mission-control", undefined);
		widgetEnabled = false;
		ctx.ui.notify("Mission Control widget disabled", "info");
	};

	const toggleWidget = (ctx: ExtensionContext) => {
		if (widgetEnabled) {
			disableWidget(ctx);
		} else {
			enableWidget(ctx);
		}
	};

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------
	pi.registerCommand("mission-control", {
		description: "Open Mission Control dashboard for monitoring agents",
		handler: openDashboard,
	});

	pi.registerCommand("mc", {
		description: "Alias for /mission-control",
		handler: openDashboard,
	});

	pi.registerCommand("mc-widget", {
		description: "Toggle Mission Control status widget (on|off)",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();
			if (cmd === "on") {
				enableWidget(ctx);
			} else if (cmd === "off") {
				disableWidget(ctx);
			} else {
				toggleWidget(ctx);
			}
		},
	});

	// -------------------------------------------------------------------------
	// Keyboard shortcut: Ctrl+Shift+M to toggle widget
	// -------------------------------------------------------------------------
	pi.registerShortcut("ctrl+shift+m", {
		description: "Toggle Mission Control widget",
		handler: async (ctx) => {
			toggleWidget(ctx);
		},
	});

	// -------------------------------------------------------------------------
	// Auto-enable widget on session start if workspace is configured
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		// Auto-enable widget if we have a workspace with agents
		if (workspaceRoot && ctx.hasUI) {
			const agents = discoverAgents(workspaceRoot);
			if (agents.length > 0) {
				enableWidget(ctx);
			}
		}
	});

	// Cleanup on shutdown
	pi.on("session_shutdown", async () => {
		if (widgetInstance) {
			widgetInstance.stop();
			widgetInstance = null;
		}
	});
}
