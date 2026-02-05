import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { platform } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  let pendingCount = 0;
  let debounceTimer: NodeJS.Timeout | null = null;

  let hasFocus = true; // assume focused until we receive a focus-out event
  const DEBOUNCE_MS = 2000; // Wait 2s of idle before notifying

  // Terminal focus reporting (xterm mode 1004)
  // Terminal sends: \x1b[I (focus in), \x1b[O (focus out)
  let focusReportingEnabled = false;

  const onStdinData = (data: Buffer) => {
    const str = data.toString("utf8");
    if (str.includes("\x1b[I")) {
      hasFocus = true;
    } else if (str.includes("\x1b[O")) {
      hasFocus = false;
    }
  };

  const enableFocusReporting = () => {
    if (focusReportingEnabled) return;
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;

    // Focus events arrive on stdin. If stdin isn't already in raw mode,
    // the escape sequences may get echoed as "^[[I" (and may not be delivered
    // as "data" events until a newline). In that case we simply don't enable
    // focus tracking.
    if (!process.stdin.isRaw) return;

    process.stdin.resume();

    // Register handler BEFORE enabling, so we don't miss the initial focus-in event.
    process.stdin.on("data", onStdinData);
    process.stdout.write("\x1b[?1004h");
    focusReportingEnabled = true;
  };

  const disableFocusReporting = () => {
    if (!focusReportingEnabled) return;

    try {
      process.stdout.write("\x1b[?1004l");
    } catch {
      // ignore
    }

    process.stdin.off("data", onStdinData);
    focusReportingEnabled = false;
  };

  // Only touch terminal modes once pi actually has a UI.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    enableFocusReporting();
  });

  pi.on("session_shutdown", async () => {
    disableFocusReporting();
  });

  const sendNotification = async (count: number) => {
    // Skip notification if terminal is focused
    if (hasFocus) return;

    const message = count > 1 ? `${count} tasks completed` : "Task completed";
    const os = platform();

    if (os === "darwin") {
      const iconPath = join(__dirname, "assets/pi-logo.png");
      await pi.exec("terminal-notifier", [
        "-title",
        "pi",
        "-message",
        message,
        "-sound",
        "default",
        "-group",
        "pi-idle",
        "-contentImage",
        iconPath,
      ]);
    } else if (os === "linux") {
      // Linux: use same ID to replace previous notification
      await pi.exec("notify-send", [
        "--app-name=pi",
        "--hint=string:x-dunst-stack-tag:pi-idle", // For dunst
        "pi",
        message,
      ]);
    }

    // Terminal bell
    process.stdout.write("\x07");
  };

  pi.on("agent_end", async () => {
    pendingCount++;

    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(async () => {
      const count = pendingCount;
      pendingCount = 0;
      debounceTimer = null;
      await sendNotification(count);
    }, DEBOUNCE_MS);
  });

  // Cancel pending notification if a new agent run starts
  pi.on("agent_start", () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      pendingCount = 0;
    }
  });
}
