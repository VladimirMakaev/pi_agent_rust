import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export default function autoloadSubdirContext(pi) {
    const loadedAgents = new Set();
    let currentCwd = "";
    let cwdAgentsPath = "";
    let homeDir = "";
    function resolvePath(targetPath, baseDir) {
        const absolute = path.isAbsolute(targetPath)
            ? path.normalize(targetPath)
            : path.resolve(baseDir, targetPath);
        try {
            return fs.realpathSync.native?.(absolute) ?? fs.realpathSync(absolute);
        }
        catch {
            return absolute;
        }
    }
    function isInsideRoot(rootDir, targetPath) {
        if (!rootDir)
            return false;
        const relative = path.relative(rootDir, targetPath);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    }
    function resetSession(cwd) {
        currentCwd = resolvePath(cwd, process.cwd());
        cwdAgentsPath = path.join(currentCwd, "AGENTS.md");
        homeDir = resolvePath(os.homedir(), process.cwd());
        loadedAgents.clear();
        loadedAgents.add(cwdAgentsPath);
    }
    function findAgentsFiles(filePath, rootDir) {
        if (!rootDir)
            return [];
        const agentsFiles = [];
        let dir = path.dirname(filePath);
        while (isInsideRoot(rootDir, dir)) {
            const candidate = path.join(dir, "AGENTS.md");
            if (candidate !== cwdAgentsPath && fs.existsSync(candidate)) {
                agentsFiles.push(candidate);
            }
            if (dir === rootDir)
                break;
            const parent = path.dirname(dir);
            if (parent === dir)
                break;
            dir = parent;
        }
        return agentsFiles.reverse();
    }
    const handleSessionChange = (_event, ctx) => {
        resetSession(ctx.cwd);
    };
    pi.on("session_start", handleSessionChange);
    pi.on("session_switch", handleSessionChange);
    pi.on("tool_result", async (event, ctx) => {
        if (event.toolName !== "read" || event.isError)
            return undefined;
        const pathInput = event.input.path;
        if (!pathInput)
            return undefined;
        if (!currentCwd)
            resetSession(ctx.cwd);
        const absolutePath = resolvePath(pathInput, currentCwd);
        const searchRoot = isInsideRoot(currentCwd, absolutePath)
            ? currentCwd
            : isInsideRoot(homeDir, absolutePath)
                ? homeDir
                : "";
        if (!searchRoot)
            return undefined;
        if (path.basename(absolutePath) === "AGENTS.md") {
            loadedAgents.add(path.normalize(absolutePath));
            return undefined;
        }
        const agentFiles = findAgentsFiles(absolutePath, searchRoot);
        const additions = [];
        for (const agentsPath of agentFiles) {
            if (loadedAgents.has(agentsPath))
                continue;
            try {
                const content = await fs.promises.readFile(agentsPath, "utf-8");
                loadedAgents.add(agentsPath);
                additions.push({
                    type: "text",
                    text: `Loaded subdirectory context from ${agentsPath}\n\n${content}`,
                });
            }
            catch (error) {
                if (ctx.hasUI)
                    ctx.ui.notify(`Failed to load ${agentsPath}: ${String(error)}`, "warning");
            }
        }
        if (!additions.length)
            return undefined;
        const baseContent = event.content ?? [];
        return { content: [...baseContent, ...additions], details: event.details };
    });
}
