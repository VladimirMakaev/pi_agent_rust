import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import https from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

type TelegramResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string };

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: JsonObject, overrides: JsonObject): JsonObject {
  const result: JsonObject = { ...base };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    if (overrideValue === undefined) continue;

    const baseValue = base[key];

    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }

  return result;
}

function loadJsonFile(path: string, ctx?: ExtensionContext): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx?.ui.notify(`Failed to read settings: ${path} (${message})`, "warning");
    return {};
  }
}

function getAgentDir(): string {
  // pi uses ~/.pi/agent by default. If overridden, it's via PI_CODING_AGENT_DIR.
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function loadMergedSettings(cwd: string, ctx?: ExtensionContext): {
  settings: JsonObject;
  globalSettingsPath: string;
  projectSettingsPath: string;
} {
  const globalSettingsPath = join(getAgentDir(), "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  const globalSettings = loadJsonFile(globalSettingsPath, ctx);
  const projectSettings = loadJsonFile(projectSettingsPath, ctx);

  return {
    settings: deepMerge(globalSettings, projectSettings),
    globalSettingsPath,
    projectSettingsPath,
  };
}

function getSetting<T>(settings: JsonObject, path: string, fallback: T): T {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = settings;

  for (const part of parts) {
    if (!isPlainObject(current)) return fallback;
    current = current[part];
  }

  return (current as T) ?? fallback;
}

function maskToken(token: string): string {
  if (!token) return "(missing)";
  if (token.length <= 10) return "(present)";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function coerceChatId(chatId: unknown): string | number | undefined {
  if (typeof chatId === "number") return chatId;
  if (typeof chatId === "string") {
    const trimmed = chatId.trim();
    if (!trimmed) return undefined;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && String(asNum) === trimmed) return asNum;
    return trimmed;
  }
  return undefined;
}

function formatNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const anyErr = error as any;
  const code = anyErr.code || anyErr.cause?.code;
  return code ? `${error.message} (${String(code)})` : error.message;
}

async function telegramCall<T>(options: {
  token: string;
  method: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  family?: 4 | 6;
}): Promise<TelegramResponse<T>> {
  const data = JSON.stringify(options.body);

  return await new Promise<TelegramResponse<T>>((resolve) => {
    const req = https.request(
      {
        protocol: "https:",
        hostname: "api.telegram.org",
        method: "POST",
        path: `/bot${options.token}/${options.method}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: options.timeoutMs,
        family: options.family,
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          try {
            const parsed = JSON.parse(text) as unknown;
            if (isPlainObject(parsed) && typeof parsed.ok === "boolean") {
              resolve(parsed as TelegramResponse<T>);
              return;
            }
            resolve({ ok: false, description: text.slice(0, 500) });
          } catch {
            resolve({ ok: false, description: text.slice(0, 500) });
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", (error) => {
      resolve({ ok: false, description: `Network error: ${formatNetworkError(error)}` });
    });

    req.write(data);
    req.end();
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, Math.max(0, maxLength - 40));
  const breakPoint = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
  const cut = breakPoint > slice.length * 0.6 ? slice.slice(0, breakPoint).trim() : slice.trim();
  return `${cut}\n\n...(truncated)`;
}

function formatToTelegramHtml(markdown: string): string {
  let result = markdown;

  // Protect code blocks first
  const codeBlocks: string[] = [];
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const index = codeBlocks.length;
    const escapedCode = escapeHtml(String(code ?? "").trim());
    codeBlocks.push(`<pre><code>${escapedCode}</code></pre>`);
    return `%%CODEBLOCK_${index}%%`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_m, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `%%INLINECODE_${index}%%`;
  });

  // Escape the rest
  result = escapeHtml(result);

  // Basic markdown → HTML conversions.
  // Keep this intentionally minimal because Telegram's HTML parser is strict.
  // (Malformed nesting causes: "can't parse entities: Unmatched end tag ...")
  result = result.replace(/^#{1,6} (.+)$/gm, "<b>$1</b>");
  result = result.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");

  // Bullets
  result = result.replace(/^(?:- |\* )/gm, "• ");

  // Restore code placeholders (use regex so we don't depend on exact placeholder formatting)
  result = result.replace(/%%CODEBLOCK_?(\d+)%%/g, (_m, i: string) => {
    const index = Number(i);
    return Number.isFinite(index) && codeBlocks[index] ? codeBlocks[index] : _m;
  });
  result = result.replace(/%%INLINECODE_?(\d+)%%/g, (_m, i: string) => {
    const index = Number(i);
    return Number.isFinite(index) && inlineCodes[index] ? inlineCodes[index] : _m;
  });

  return result.trim();
}

function extractText(message: unknown): string {
  if (!isPlainObject(message)) return "";

  const content = message.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!isPlainObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        const t = block.text.trim();
        if (t) parts.push(t);
      }
    }
    return parts.join("\n").trim();
  }

  return "";
}

function findFirstByRole(messages: unknown[], role: string): JsonObject | undefined {
  for (const msg of messages) {
    if (isPlainObject(msg) && msg.role === role) return msg;
  }
  return undefined;
}

function findLastByRole(messages: unknown[], role: string): JsonObject | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isPlainObject(msg) && msg.role === role) return msg;
  }
  return undefined;
}

function collectToolErrors(messages: unknown[], maxItems: number): Array<{ tool: string; text: string }> {
  const errors: Array<{ tool: string; text: string }> = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isPlainObject(msg)) continue;
    if (msg.role !== "toolResult") continue;
    if (msg.isError !== true) continue;

    const tool = typeof msg.toolName === "string" ? msg.toolName : "(unknown)";
    const text = truncateText(extractText(msg), 300);

    errors.push({ tool, text });
    if (errors.length >= maxItems) break;
  }

  return errors.reverse();
}

function buildTelegramMessage(ctx: ExtensionContext, messages: unknown[], settings: JsonObject, maxLen: number): string {
  const header = ctx.sessionManager.getHeader();
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionIdShort = sessionId ? sessionId.slice(0, 8) : "";
  const leafId = ctx.sessionManager.getLeafId();

  const includePrompt = getSetting(settings, "notifications.telegram.includePrompt", false);
  const includeToolErrors = getSetting(settings, "notifications.telegram.includeToolErrors", true);
  const includeLeaf = getSetting(settings, "notifications.telegram.includeLeaf", false);
  const includeStarted = getSetting(settings, "notifications.telegram.includeStarted", false);

  const firstUser = includePrompt ? findFirstByRole(messages, "user") : undefined;
  const lastAssistant = findLastByRole(messages, "assistant");

  const prompt = firstUser ? truncateText(extractText(firstUser), 900) : "";
  const answerRaw = lastAssistant ? extractText(lastAssistant) : "";

  const toolErrors = includeToolErrors ? collectToolErrors(messages, 3) : [];

  const resumeHint = sessionIdShort ? `pi --session ${sessionIdShort}` : "";

  const lines: string[] = [];
  lines.push(`<b>Pi is ready</b>${sessionIdShort ? ` • <code>${escapeHtml(sessionIdShort)}</code>` : ""}`);
  if (sessionId) lines.push(`session: <code>${escapeHtml(sessionId)}</code>`);
  lines.push(`cwd: <code>${escapeHtml(ctx.cwd)}</code>`);
  if (includeLeaf && leafId) lines.push(`leaf: <code>${escapeHtml(String(leafId))}</code>`);
  if (includeStarted && header?.timestamp) lines.push(`started: <code>${escapeHtml(header.timestamp)}</code>`);
  if (resumeHint) lines.push(`resume: <code>${escapeHtml(resumeHint)}</code>`);

  if (prompt) {
    lines.push("");
    lines.push(`<b>Prompt</b>`);
    lines.push(formatToTelegramHtml(prompt));
  }

  if (toolErrors.length > 0) {
    lines.push("");
    lines.push(`<b>Tool errors</b>`);
    for (const err of toolErrors) {
      lines.push(`<b>${escapeHtml(err.tool)}</b>: ${formatToTelegramHtml(err.text)}`);
    }
  }

  lines.push("");
  lines.push(`<b>Last answer</b>`);

  // Keep answer itself as the main payload.
  const preMax = Math.max(800, maxLen - lines.join("\n").length - 50);
  const answer = truncateText(answerRaw || "(no assistant output)", preMax);
  lines.push(formatToTelegramHtml(answer));

  // Safety: keep under Telegram limit
  const joined = lines.join("\n").trim();
  if (joined.length <= maxLen) return joined;

  const tighterAnswer = truncateText(answerRaw || "(no assistant output)", Math.max(200, preMax - 800));
  const rebuilt = [...lines.slice(0, -1), formatToTelegramHtml(tighterAnswer)].join("\n").trim();
  return rebuilt.length <= maxLen ? rebuilt : rebuilt.slice(0, maxLen - 20).trim() + "\n...(truncated)";
}

function buildTelegramPlainMessage(ctx: ExtensionContext, messages: unknown[], settings: JsonObject, maxLen: number): string {
  const header = ctx.sessionManager.getHeader();
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionIdShort = sessionId ? sessionId.slice(0, 8) : "";
  const leafId = ctx.sessionManager.getLeafId();

  const includePrompt = getSetting(settings, "notifications.telegram.includePrompt", false);
  const includeToolErrors = getSetting(settings, "notifications.telegram.includeToolErrors", true);
  const includeLeaf = getSetting(settings, "notifications.telegram.includeLeaf", false);
  const includeStarted = getSetting(settings, "notifications.telegram.includeStarted", false);

  const firstUser = includePrompt ? findFirstByRole(messages, "user") : undefined;
  const lastAssistant = findLastByRole(messages, "assistant");

  const prompt = firstUser ? truncateText(extractText(firstUser), 900) : "";
  const answerRaw = lastAssistant ? extractText(lastAssistant) : "";

  const toolErrors = includeToolErrors ? collectToolErrors(messages, 3) : [];

  const resumeHint = sessionIdShort ? `pi --session ${sessionIdShort}` : "";

  const lines: string[] = [];
  lines.push(`Pi is ready${sessionIdShort ? ` • ${sessionIdShort}` : ""}`);
  if (sessionId) lines.push(`session: ${sessionId}`);
  lines.push(`cwd: ${ctx.cwd}`);
  if (includeLeaf && leafId) lines.push(`leaf: ${String(leafId)}`);
  if (includeStarted && header?.timestamp) lines.push(`started: ${header.timestamp}`);
  if (resumeHint) lines.push(`resume: ${resumeHint}`);

  if (prompt) {
    lines.push("");
    lines.push("Prompt");
    lines.push(prompt);
  }

  if (toolErrors.length > 0) {
    lines.push("");
    lines.push("Tool errors");
    for (const err of toolErrors) {
      lines.push(`${err.tool}: ${err.text}`);
    }
  }

  lines.push("");
  lines.push("Last answer");

  const preMax = Math.max(800, maxLen - lines.join("\n").length - 50);
  const answer = truncateText(answerRaw || "(no assistant output)", preMax);
  lines.push(answer);

  const joined = lines.join("\n").trim();
  if (joined.length <= maxLen) return joined;

  const tighterAnswer = truncateText(answerRaw || "(no assistant output)", Math.max(200, preMax - 800));
  const rebuilt = [...lines.slice(0, -1), tighterAnswer].join("\n").trim();
  return rebuilt.length <= maxLen ? rebuilt : rebuilt.slice(0, maxLen - 20).trim() + "\n...(truncated)";
}

export default function (pi: ExtensionAPI) {
  async function ringBell(ctx: ExtensionContext, settings: JsonObject) {
    // Many terminals (including Alacritty) don't do an audible bell. We still emit BEL,
    // and optionally run a user-specified command (useful on Windows/WSL).
    process.stdout.write("\x07");
    process.stderr.write("\x07");

    const bellCommand = String(getSetting(settings, "notifications.bellCommand", "")).trim();
    if (!bellCommand) return;

    const timeoutMsRaw = getSetting(settings, "notifications.bellCommandTimeoutMs", 1500);
    const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : 1500;

    try {
      await pi.exec("bash", ["-lc", bellCommand], { timeout: timeoutMs });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Bell command failed: ${message}`, "warning");
    }
  }

  async function sendTelegram(
    payload: { html: string; text: string },
    ctx: ExtensionContext,
    settings: JsonObject,
  ) {
    const enableTelegram = getSetting(settings, "notifications.telegram.enabled", false);
    if (!enableTelegram) return;

    const tokenFromSettings = String(getSetting(settings, "notifications.telegram.token", "")).trim();
    const telegramToken = tokenFromSettings || process.env.TELEGRAM_BOT_TOKEN || process.env.PI_TELEGRAM_TOKEN || "";

    const chatIdFromSettings = getSetting(settings, "notifications.telegram.chatId", "");
    const telegramChatId =
      coerceChatId(chatIdFromSettings) ??
      coerceChatId(process.env.TELEGRAM_CHAT_ID) ??
      coerceChatId(process.env.PI_TELEGRAM_CHAT_ID);

    const timeoutMsRaw = getSetting(settings, "notifications.telegram.timeoutMs", 5000);
    const timeoutMs = typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : 5000;

    const forceIpv4 = getSetting(settings, "notifications.telegram.forceIpv4", true);

    if (!telegramToken || telegramChatId === undefined) {
      ctx.ui.notify("Telegram config missing (notifications.telegram.token/chatId)", "warning");
      return;
    }

    const htmlResult = await telegramCall<{ message_id: number }>({
      token: telegramToken,
      method: "sendMessage",
      body: {
        chat_id: telegramChatId,
        text: payload.html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      timeoutMs,
      family: forceIpv4 ? 4 : undefined,
    });

    if (htmlResult.ok) return;

    const htmlDesc = htmlResult.description || "Unknown Telegram error";
    const htmlCode = htmlResult.error_code ? ` (code ${htmlResult.error_code})` : "";

    // If HTML parsing fails, fall back to plain text so notifications still get delivered.
    if (htmlResult.error_code === 400 && htmlDesc.includes("can't parse entities")) {
      const plainResult = await telegramCall<{ message_id: number }>({
        token: telegramToken,
        method: "sendMessage",
        body: {
          chat_id: telegramChatId,
          text: payload.text,
          disable_web_page_preview: true,
        },
        timeoutMs,
        family: forceIpv4 ? 4 : undefined,
      });

      if (plainResult.ok) return;

      const plainDesc = plainResult.description || "Unknown Telegram error";
      const plainCode = plainResult.error_code ? ` (code ${plainResult.error_code})` : "";
      throw new Error(`Telegram send failed (HTML parse error fallback): ${htmlDesc}${htmlCode}; plain: ${plainDesc}${plainCode}`);
    }

    throw new Error(`${htmlDesc}${htmlCode}`);
  }

  // Notify once per agent loop (one user prompt), not once per turn.
  pi.on("agent_end", async (event, ctx) => {
    // If we're not idle, it's probably mid-stream; avoid noisy notifications.
    if (!ctx.isIdle()) return;

    const { settings } = loadMergedSettings(ctx.cwd, ctx);
    const enableBell = getSetting(settings, "notifications.bell", true);

    if (enableBell) {
      await ringBell(ctx, settings);
    }

    const htmlMessage = buildTelegramMessage(ctx, event.messages as unknown[], settings, 3900);
    const plainMessage = buildTelegramPlainMessage(ctx, event.messages as unknown[], settings, 3900);

    try {
      await sendTelegram({ html: htmlMessage, text: plainMessage }, ctx, settings);
    } catch (error: unknown) {
      const err = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Telegram notification failed: ${err}`, "error");
    }
  });

  pi.registerCommand("notify", {
    description: "Test notifications (use: /notify debug)",
    handler: async (args, ctx) => {
      const { settings, globalSettingsPath, projectSettingsPath } = loadMergedSettings(ctx.cwd, ctx);

      const enableBell = getSetting(settings, "notifications.bell", true);
      if (enableBell) {
        await ringBell(ctx, settings);
      }
      ctx.ui.notify("Test notification!", "info");

      const enableTelegram = getSetting(settings, "notifications.telegram.enabled", false);

      if (args.trim() === "debug") {
        const token = String(getSetting(settings, "notifications.telegram.token", "")).trim();
        const rawChatId = getSetting(settings, "notifications.telegram.chatId", "");
        const chatId = coerceChatId(rawChatId);
        const timeoutMs = getSetting(settings, "notifications.telegram.timeoutMs", 5000);
        const forceIpv4 = getSetting(settings, "notifications.telegram.forceIpv4", true);
        const bellCommand = String(getSetting(settings, "notifications.bellCommand", "")).trim();

        ctx.ui.notify(
          `notify debug: bell=${enableBell}, bellCommand=${bellCommand ? "(set)" : "(unset)"}, telegram=${enableTelegram}, token=${maskToken(token)}, chatId=${chatId ?? "(missing)"}, timeoutMs=${String(timeoutMs)}, forceIpv4=${String(forceIpv4)}`,
          "info",
        );
        ctx.ui.notify(`settings: global=${globalSettingsPath}`, "info");
        ctx.ui.notify(`settings: project=${projectSettingsPath}`, "info");

        if (enableTelegram && token) {
          const me = await telegramCall<{ username?: string; id: number }>({
            token,
            method: "getMe",
            body: {},
            timeoutMs: 3000,
            family: forceIpv4 ? 4 : undefined,
          });
          if (me.ok) {
            ctx.ui.notify(`Telegram getMe ok: @${me.result.username ?? "(no username)"} (${me.result.id})`, "info");
          } else {
            ctx.ui.notify(
              `Telegram getMe failed: ${me.description ?? "Unknown error"}${me.error_code ? ` (code ${me.error_code})` : ""}`,
              "warning",
            );
          }
        }
      }

      try {
        await sendTelegram({ html: "<b>Pi test notification</b>", text: "Pi test notification" }, ctx, settings);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Telegram notification failed: ${message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Notification extension loaded (/notify)", "info");
  });
}
