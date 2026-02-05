/**
 * Files Extension
 *
 * Tracks files read/written/edited by the agent in the current session.
 * Use /files (or optional shortcut) to select a file and open it in your editor.
 * Files are sorted by most recent access, with operation indicators (R/W/E).
 *
 * Settings (configurable via /extension-settings):
 * - editorCommand: Command to open files (space-separated, e.g., "code -g")
 * - shortcut: Keyboard shortcut to open file list (e.g., "ctrl+f")
 */
import * as path from "node:path";
import { getSetting } from "@juanibiapina/pi-extension-settings";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text } from "@mariozechner/pi-tui";
function toRelativePath(filePath, cwd) {
    if (path.isAbsolute(filePath)) {
        const rel = path.relative(cwd, filePath);
        return rel || filePath;
    }
    return filePath;
}
function rebuildFromSession(ctx, cwd) {
    const fileMap = new Map();
    const branch = ctx.sessionManager.getBranch();
    // First pass: collect tool calls (id -> {path, name, timestamp})
    const toolCalls = new Map();
    for (const entry of branch) {
        if (entry.type !== "message")
            continue;
        const msg = entry.message;
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (block.type === "toolCall") {
                    const name = block.name;
                    if (name === "read" || name === "write" || name === "edit") {
                        const toolPath = block.arguments?.path;
                        if (toolPath && typeof toolPath === "string") {
                            toolCalls.set(block.id, {
                                path: toRelativePath(toolPath, cwd),
                                name: name,
                                timestamp: msg.timestamp,
                            });
                        }
                    }
                }
            }
        }
    }
    // Second pass: match tool results to get actual execution timestamp
    for (const entry of branch) {
        if (entry.type !== "message")
            continue;
        const msg = entry.message;
        if (msg.role === "toolResult") {
            const toolCall = toolCalls.get(msg.toolCallId);
            if (!toolCall)
                continue;
            const { path: filePath, name } = toolCall;
            const timestamp = msg.timestamp;
            const existing = fileMap.get(filePath);
            if (existing) {
                existing.operations.add(name);
                if (timestamp > existing.lastTimestamp) {
                    existing.lastTimestamp = timestamp;
                }
            }
            else {
                fileMap.set(filePath, {
                    path: filePath,
                    operations: new Set([name]),
                    lastTimestamp: timestamp,
                });
            }
        }
    }
    return fileMap;
}
export default function (pi) {
    // Register settings via event (for /extension-settings UI)
    pi.events.emit("pi-extension-settings:register", {
        name: "files",
        settings: [
            {
                id: "editorCommand",
                label: "Editor command",
                description: "Command to open files (space-separated, path is appended). Example: code -g",
                defaultValue: "",
            },
            {
                id: "shortcut",
                label: "Keyboard shortcut",
                description: "Shortcut to open file list. Example: ctrl+f",
                defaultValue: "",
            },
        ],
    });
    let fileMap = new Map();
    let cwd = "";
    // Handler for showing file list
    const showFileList = async (ctx) => {
        if (!ctx.hasUI) {
            ctx.ui.notify("No UI available", "error");
            return;
        }
        if (fileMap.size === 0) {
            ctx.ui.notify("No files mentioned yet", "info");
            return;
        }
        // Sort by most recent first
        const files = Array.from(fileMap.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
        const openSelected = async (file) => {
            const editorCommand = getSetting("files", "editorCommand");
            if (!editorCommand) {
                ctx.ui.notify("editorCommand not configured", "error");
                return;
            }
            const parts = editorCommand.split(/\s+/).filter(Boolean);
            if (parts.length === 0) {
                ctx.ui.notify("editorCommand not configured", "error");
                return;
            }
            const [cmd, ...args] = parts;
            const result = await pi.exec(cmd, [...args, file.path]);
            ctx.ui.notify(result.code === 0 ? `Opened ${file.path}` : `Error: ${result.stderr}`, result.code === 0 ? "info" : "error");
        };
        // Show file picker with SelectList
        await ctx.ui.custom((tui, theme, _kb, done) => {
            const container = new Container();
            // Top border
            container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
            // Title
            container.addChild(new Text(theme.fg("accent", theme.bold(" Select file to open")), 0, 0));
            // Build select items with colored operations
            const items = files.map((f) => {
                const ops = [];
                if (f.operations.has("read"))
                    ops.push(theme.fg("muted", "R"));
                if (f.operations.has("write"))
                    ops.push(theme.fg("success", "W"));
                if (f.operations.has("edit"))
                    ops.push(theme.fg("warning", "E"));
                const opsLabel = ops.join("");
                return {
                    value: f.path,
                    label: `${opsLabel} ${f.path}`,
                };
            });
            const visibleRows = Math.min(files.length, 15);
            let currentIndex = 0;
            const selectList = new SelectList(items, visibleRows, {
                selectedPrefix: (t) => theme.fg("accent", t),
                selectedText: (t) => t,
                description: (t) => theme.fg("muted", t),
                scrollInfo: (t) => theme.fg("dim", t),
                noMatch: (t) => theme.fg("warning", t),
            });
            selectList.onSelect = (item) => {
                done();
                const entry = fileMap.get(item.value);
                if (entry)
                    void openSelected(entry);
            };
            selectList.onCancel = () => done();
            selectList.onSelectionChange = (item) => {
                currentIndex = items.indexOf(item);
            };
            container.addChild(selectList);
            // Help text
            container.addChild(new Text(theme.fg("dim", " ↑↓ navigate • ←→ page • enter open • esc close"), 0, 0));
            // Bottom border
            container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
            return {
                render: (w) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data) => {
                    if (matchesKey(data, Key.left)) {
                        currentIndex = Math.max(0, currentIndex - visibleRows);
                        selectList.setSelectedIndex(currentIndex);
                    }
                    else if (matchesKey(data, Key.right)) {
                        currentIndex = Math.min(items.length - 1, currentIndex + visibleRows);
                        selectList.setSelectedIndex(currentIndex);
                    }
                    else {
                        selectList.handleInput(data);
                    }
                    tui.requestRender();
                },
            };
        });
    };
    // Command to show and select from mentioned files
    pi.registerCommand("files", {
        description: "Show and select from mentioned files",
        handler: async (_args, ctx) => showFileList(ctx),
    });
    // Shortcut to show file list (if configured)
    const shortcut = getSetting("files", "shortcut");
    if (shortcut) {
        pi.registerShortcut(shortcut, {
            description: "Show and select from mentioned files",
            handler: async (ctx) => showFileList(ctx),
        });
    }
    // Collect paths from file tool calls
    pi.on("tool_call", async (event, ctx) => {
        if (!ctx.hasUI)
            return;
        const name = event.toolName;
        if (name === "read" || name === "write" || name === "edit") {
            const input = event.input;
            if (input?.path) {
                const filePath = toRelativePath(input.path, cwd);
                const existing = fileMap.get(filePath);
                const timestamp = Date.now();
                if (existing) {
                    existing.operations.add(name);
                    existing.lastTimestamp = timestamp;
                }
                else {
                    fileMap.set(filePath, {
                        path: filePath,
                        operations: new Set([name]),
                        lastTimestamp: timestamp,
                    });
                }
            }
        }
    });
    // Clear on session switch
    pi.on("session_switch", async (_event, _ctx) => {
        fileMap.clear();
    });
    // Rebuild from session on start (handles resume)
    pi.on("session_start", async (_event, ctx) => {
        cwd = ctx.cwd;
        fileMap = rebuildFromSession(ctx, cwd);
    });
}
//# sourceMappingURL=index.js.map