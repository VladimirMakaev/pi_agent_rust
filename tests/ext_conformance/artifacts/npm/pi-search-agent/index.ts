/**
 * Semantic Codebase Search Extension
 * 
 * Provides semantic search capabilities for codebases with sub-agent processing.
 * 
 * Features:
 * - Creates semantic index using embeddings
 * - Natural language search with relevance ranking
 * - Sub-agent processing for result curation
 * - Interactive TUI interface
 * - Progress tracking and status indicators
 */

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

// Load extension-specific .env file into isolated config (doesn't touch process.env)
const __extensionDir = path.dirname(fileURLToPath(import.meta.url));
const ENV_DIR = path.join(os.homedir(), ".pi", "extensions", "pi-search-agent");
const ENV_PATH = path.join(ENV_DIR, ".env");
const ENV_OPENAI_KEY = "OPENAI_API_KEY";
const ENV_SEARCH_PROVIDER = "SEARCH_PROVIDER";
const ENV_SEARCH_MODEL = "SEARCH_MODEL";

const loadExtensionEnv = (): Record<string, string> => {
  if (fs.existsSync(ENV_PATH)) {
    return dotenv.parse(fs.readFileSync(ENV_PATH));
  }
  return {};
};

const writeExtensionEnv = (env: Record<string, string>): void => {
  const orderedKeys = [
    ENV_OPENAI_KEY,
    ENV_SEARCH_PROVIDER,
    ENV_SEARCH_MODEL,
    ...Object.keys(env)
      .filter((key) => ![ENV_OPENAI_KEY, ENV_SEARCH_PROVIDER, ENV_SEARCH_MODEL].includes(key))
      .sort()
  ];

  const lines = orderedKeys
    .filter((key) => env[key] !== undefined && env[key] !== null)
    .map((key) => `${key}=${env[key] ?? ""}`);

  if (!fs.existsSync(ENV_DIR)) {
    fs.mkdirSync(ENV_DIR, { recursive: true });
  }

  fs.writeFileSync(ENV_PATH, `${lines.join("\n")}\n`, "utf-8");
};

let extensionEnv = loadExtensionEnv();

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  Container,
  Spacer,
  Text
} from "@mariozechner/pi-tui";
import { matchesKey, Key } from "@mariozechner/pi-tui";
import OpenAI from "openai";

// Configuration and types
interface FileChunk {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  embedding?: number[];
  indexedAt?: number; // Track when this chunk was indexed
  contentHash?: string; // Content fingerprint for caching
}

interface SearchResult {
  chunk: FileChunk;
  score: number;
  excerpt: string;
}

interface FileMatch {
  path: string;
  absolutePath: string;
  score: number;
  startLine: number;
  endLine: number;
  snippet: string;
}

interface CombinedFileMatch extends FileMatch {
  queries: string[];
}

interface UsageSnapshot {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: {
    total?: number;
  };
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
}

interface EmbeddingCache {
  hash: string;
  embedding: number[];
  createdAt: number;
}

interface IndexMetadata {
  version: string;
  createdAt: number;
  lastUpdated: number; // When the index was last updated
  fileCount: number;
  chunkCount: number;
  paths: string[];
  patterns: string[];
  fileIndexTimes?: Record<string, number>; // Track when each file was last indexed
}

type ChunkFileInfo = { path: string; format: "jsonl" | "json" };

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = [];
  const executing = new Set<Promise<void>>();
  const safeLimit = Math.max(1, limit);

  for (const task of tasks) {
    let wrapped: Promise<void>;
    wrapped = task()
      .then((result) => {
        results.push(result);
      })
      .finally(() => {
        executing.delete(wrapped);
      });

    executing.add(wrapped);

    if (executing.size >= safeLimit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

function getIndexDir(cwd: string): string {
  const hash = Buffer.from(cwd).toString("base64").replace(/[\/+=]/g, "");
  return path.join(os.homedir(), ".pi", "agent", "cache", "semantic-search", hash);
}

function getChunksFileInfo(cwd: string): ChunkFileInfo | null {
  const jsonlPath = path.join(getIndexDir(cwd), CHUNKS_JSONL);
  if (fs.existsSync(jsonlPath)) {
    return { path: jsonlPath, format: "jsonl" };
  }

  const jsonPath = path.join(getIndexDir(cwd), CHUNKS_JSON);
  if (fs.existsSync(jsonPath)) {
    return { path: jsonPath, format: "json" };
  }

  return null;
}

function writeChunksJsonlSync(filePath: string, chunks: FileChunk[]): void {
  const fd = fs.openSync(filePath, "w");
  try {
    for (const chunk of chunks) {
      fs.writeSync(fd, `${JSON.stringify(chunk)}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function loadAllChunks(cwd: string): FileChunk[] {
  const info = getChunksFileInfo(cwd);
  if (!info) return [];

  try {
    if (info.format === "jsonl") {
      const content = fs.readFileSync(info.path, "utf-8");
      if (!content.trim()) return [];
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    }

    return JSON.parse(fs.readFileSync(info.path, "utf-8"));
  } catch {
    return [];
  }
}

const DEFAULT_PATTERNS = [
  '**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx',  // JavaScript/TypeScript
  '**/*.py',                                       // Python
  '**/*.java', '**/*.kt',                          // JVM
  '**/*.rs',                                       // Rust
  '**/*.go',                                       // Go
  '**/*.c', '**/*.cpp', '**/*.h', '**/*.hpp',      // C/C++
  '**/*.rb',                                       // Ruby
  '**/*.php',                                      // PHP
  '**/*.swift',                                    // Swift
  '**/*.md',                                       // Markdown
];
const CHUNK_SIZE = 1000; // characters per chunk
const CHUNK_OVERLAP = 150; // overlap between chunks
const MAX_BATCH_TOKENS = 4000; // Stay well under 8k token limit
const MAX_PARALLEL_REQUESTS = 20; // Number of parallel API requests
const MAX_CHUNKS_PER_BATCH = 10; // Hard limit on chunks per batch
const MAX_FILTER_CHUNKS_PER_FILE = 1; // Keep prompts small for GLM filtering
const MAX_FILTER_CHARS_PER_CHUNK = 400; // Cap chunk size for GLM prompts
const MAX_FILTER_TOTAL_CHARS = 800; // Cap total prompt content per file
const MAX_SUMMARY_FILES = 6; // Cap files sent to summary model
const MAX_SUMMARY_CHARS_PER_FILE = 1200; // Cap summary context per file
const DEFAULT_PROVIDER = 'cerebras'; // Provider for parallel filtering
const DEFAULT_MODEL = 'glm-4.7'; // Fast GLM model via cerebras
const DISCOVERY_PROGRESS_EVERY = 200;
const CHUNK_YIELD_EVERY = 25;

let configuredSearchProvider = extensionEnv[ENV_SEARCH_PROVIDER]?.trim() || "";
let configuredSearchModel = extensionEnv[ENV_SEARCH_MODEL]?.trim() || "";

const syncSearchSettingsFromEnv = (): void => {
  configuredSearchProvider = extensionEnv[ENV_SEARCH_PROVIDER]?.trim() || "";
  configuredSearchModel = extensionEnv[ENV_SEARCH_MODEL]?.trim() || "";
};

syncSearchSettingsFromEnv();

const getSearchProvider = (): string => configuredSearchProvider || DEFAULT_PROVIDER;
const getSearchModel = (): string => configuredSearchModel || DEFAULT_MODEL;
const getSearchModelLabel = (): string => `${getSearchProvider()}/${getSearchModel()}`;
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const DEFAULT_MODEL_COST_PER_MILLION = {
  input: 0.6,
  output: 2.2,
  cacheRead: 0.11,
  cacheWrite: 0,
};
const CHUNKS_JSON = 'chunks.json';
const CHUNKS_JSONL = 'chunks.jsonl';
const DEFAULT_TOP_K = 20;
const MIN_SIMILARITY = 0.3;
const MAX_PREVIEW_SNIPPET_CHARS = 280;
const MAX_PREVIEW_TOTAL_CHARS = 5000;
const DEFAULT_MODE = "code";
const SEARCH_AGENT_IDENTITY_FILE = path.join(__extensionDir, "SEARCH_AGENT.md");
const SUBAGENT_LOG_DIR = path.join(os.homedir(), ".pi", "agent", "cache", "semantic-search", "subagent-logs");
const IS_SUBAGENT = process.env.PI_SEMANTIC_SUBAGENT === "1";
const ENABLE_LEGACY_TOOLS = process.env.PI_SEMANTIC_LEGACY === "1" && !IS_SUBAGENT;

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath === "~") {
    return os.homedir();
  }
  return filePath;
}

function hasGlobChars(value: string): boolean {
  return /[*?[\]]/.test(value);
}

function globToRegExp(glob: string): RegExp {
  let regex = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      const next = glob[i + 1];
      if (next === "*") {
        regex += ".*";
        i++;
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    if (char === "/") {
      regex += "/";
      continue;
    }
    regex += char.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex);
}

function createPathFilter(cwd: string, filter?: string): (filePath: string) => boolean {
  if (!filter) return () => true;
  const trimmed = filter.trim();
  if (!trimmed) return () => true;

  const absolute = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  if (fs.existsSync(absolute)) {
    try {
      const stats = fs.statSync(absolute);
      if (stats.isFile()) {
        const target = path.resolve(absolute);
        return (filePath) => path.resolve(filePath) === target;
      }
      if (stats.isDirectory()) {
        const dir = path.resolve(absolute);
        const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
        return (filePath) => {
          const resolved = path.resolve(filePath);
          return resolved === dir || resolved.startsWith(prefix);
        };
      }
    } catch {
      return () => true;
    }
  }

  const normalized = toPosixPath(trimmed);
  if (hasGlobChars(normalized)) {
    const regex = globToRegExp(normalized);
    return (filePath) => regex.test(toPosixPath(path.relative(cwd, filePath)));
  }

  return (filePath) => toPosixPath(path.relative(cwd, filePath)).includes(normalized);
}

function formatSnippet(content: string, maxChars: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.substring(0, maxChars)}...`;
}

function ensureSubagentLogDir(): string {
  if (!fs.existsSync(SUBAGENT_LOG_DIR)) {
    fs.mkdirSync(SUBAGENT_LOG_DIR, { recursive: true });
  }
  return SUBAGENT_LOG_DIR;
}

function createSubagentLogPath(): string {
  const dir = ensureSubagentLogDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  return path.join(dir, `subagent-${stamp}-${rand}.jsonl`);
}

function extractAssistantText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

function createUsageTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalCost: 0
  };
}

function calculateUsageCost(usage: UsageSnapshot): number {
  const totalCost = usage.cost?.total ?? 0;
  if (totalCost > 0) return totalCost;

  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    return totalCost;
  }

  return (
    input * DEFAULT_MODEL_COST_PER_MILLION.input +
    output * DEFAULT_MODEL_COST_PER_MILLION.output +
    cacheRead * DEFAULT_MODEL_COST_PER_MILLION.cacheRead +
    cacheWrite * DEFAULT_MODEL_COST_PER_MILLION.cacheWrite
  ) / 1_000_000;
}

function addUsageTotals(totals: UsageTotals, usage?: UsageSnapshot): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.totalCost += calculateUsageCost(usage);
}

function formatUsageCostLine(usage?: UsageTotals): string {
  if (!usage) return "";
  const hasUsage = Boolean(
    usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.totalCost
  );
  if (!hasUsage) return "";
  const label = getSearchModelLabel();
  const recommended = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
  const suffix = label === recommended ? "" : " (est.)";
  return `${label} cost${suffix}: $${usage.totalCost.toFixed(4)}`;
}

// Run pi using @file to avoid argv limits (pi handles auth)
async function callLLM(prompt: string, cwd: string, signal?: AbortSignal): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-llm-"));
  const promptFile = path.join(tmpDir, "prompt.txt");
  fs.writeFileSync(promptFile, prompt, "utf-8");

  return new Promise((resolve, reject) => {
    let cleaned = false;
    let settled = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const provider = getSearchProvider();
    const model = getSearchModel();

    const proc = spawn('pi', [
      '--print',
      '--provider', provider,
      '--model', model,
      '--thinking', 'off',
      '--no-session',
      `@${promptFile}`
    ], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      cleanup();
      settle(() => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`pi exited with code ${code}: ${stderr}`));
        }
      });
    });

    proc.on('error', (err) => {
      cleanup();
      settle(() => reject(err));
    });

    if (signal) {
      const killProc = () => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      };

      if (signal.aborted) {
        killProc();
        settle(() => reject(new Error('Aborted')));
      } else {
        signal.addEventListener('abort', () => {
          killProc();
          settle(() => reject(new Error('Aborted')));
        }, { once: true });
      }
    }
  });
}

async function callSearchAgent(
  prompt: string,
  cwd: string,
  signal?: AbortSignal,
  options?: { logFile?: string; captureUsage?: boolean }
): Promise<{ output: string; logFile?: string; usage?: UsageTotals }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-"));
  const promptFile = path.join(tmpDir, "prompt.txt");
  fs.writeFileSync(promptFile, prompt, "utf-8");

  const appendPrompt = fs.existsSync(SEARCH_AGENT_IDENTITY_FILE)
    ? SEARCH_AGENT_IDENTITY_FILE
    : "You are a read-only search subagent. Use local_embedding_search when needed. Do not write files.";

  const logFile = options?.logFile;
  const captureUsage = options?.captureUsage ?? false;
  const jsonMode = Boolean(logFile) || captureUsage;
  const maxCapture = 20000;
  let capturedOutput = "";
  let parseBuffer = "";
  let finalAssistantText = "";
  const usageTotals = captureUsage ? createUsageTotals() : undefined;

  const provider = getSearchProvider();
  const model = getSearchModel();

  const logStream = logFile ? fs.createWriteStream(logFile, { encoding: "utf-8" }) : null;

  const handleJsonChunk = (chunk: string, flush: boolean) => {
    parseBuffer += chunk;
    const parts = parseBuffer.split("\n");
    if (!flush) {
      parseBuffer = parts.pop() ?? "";
    } else {
      parseBuffer = "";
    }

    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        // Check message_end for intermediate assistant messages
        if (event?.type === "message_end" && event?.message?.role === "assistant") {
          const text = extractAssistantText(event.message);
          if (text) finalAssistantText = text;
          if (captureUsage && usageTotals) {
            const usage = event.message?.usage as UsageSnapshot | undefined;
            addUsageTotals(usageTotals, usage);
          }
        }
        // Also check agent_end which contains the final messages array
        if (event?.type === "agent_end" && Array.isArray(event?.messages)) {
          // Get the last assistant message
          for (let i = event.messages.length - 1; i >= 0; i--) {
            const msg = event.messages[i];
            if (msg?.role === "assistant") {
              const text = extractAssistantText(msg);
              if (text) {
                finalAssistantText = text;
                break;
              }
            }
          }
        }
      } catch {
        // Ignore malformed event lines
      }
    }
  };

  const finishLog = () => new Promise<void>((resolve) => {
    if (!logStream) {
      resolve();
      return;
    }
    logStream.end(() => resolve());
  });

  return new Promise((resolve, reject) => {
    let cleaned = false;
    let settled = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const args = [
      "--print",
      ...(jsonMode ? ["--mode", "json"] : []),
      "--provider", provider,
      "--model", model,
      "--thinking", "off",
      "--no-session",
      "--append-system-prompt", appendPrompt,
      "--tools", "read",
      `@${promptFile}`
    ];

    const proc = spawn('pi', args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PI_SEMANTIC_SUBAGENT: "1"
      }
    });

    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      if (logStream) {
        logStream.write(text);
      }
      if (jsonMode) {
        handleJsonChunk(text, false);
      } else if (capturedOutput.length < maxCapture) {
        const remaining = maxCapture - capturedOutput.length;
        capturedOutput += text.slice(0, remaining);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (jsonMode) {
        handleJsonChunk("", true);
      }
      finishLog().finally(() => {
        cleanup();
        const output = jsonMode
          ? (finalAssistantText.trim() || "No assistant output captured. See subagent log.")
          : capturedOutput.trim();
        const result: { output: string; logFile?: string; usage?: UsageTotals } = { output, logFile };
        if (captureUsage && usageTotals) {
          result.usage = usageTotals;
        }
        settle(() => {
          if (code === 0) {
            resolve(result);
          } else {
            reject(new Error(`pi exited with code ${code}: ${stderr}`));
          }
        });
      });
    });

    proc.on('error', (err) => {
      finishLog().finally(() => {
        cleanup();
        settle(() => reject(err));
      });
    });

    if (signal) {
      const killProc = () => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      };

      if (signal.aborted) {
        killProc();
        settle(() => reject(new Error('Aborted')));
      } else {
        signal.addEventListener('abort', () => {
          killProc();
          settle(() => reject(new Error('Aborted')));
        }, { once: true });
      }
    }
  });
}

// Embedding cache helpers
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LEGACY_CACHE_MAX_MIGRATE_BYTES = 500 * 1024 * 1024;
let lastCacheCleanup = 0;
let legacyCacheChecked = false;

function getContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

function getEmbeddingCacheDir(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'cache', 'semantic-search', 'embeddings');
}

function getEmbeddingCacheFile(hash: string): string {
  return path.join(getEmbeddingCacheDir(), `${hash}.json`);
}

function ensureEmbeddingCacheDir(): void {
  const dir = getEmbeddingCacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadEmbeddingEntry(hash: string): EmbeddingCache | null {
  const filePath = getEmbeddingCacheFile(hash);
  if (!fs.existsSync(filePath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EmbeddingCache;
    if (!data?.embedding || !Array.isArray(data.embedding)) return null;
    return data;
  } catch {
    return null;
  }
}

function saveEmbeddingEntry(entry: EmbeddingCache): void {
  ensureEmbeddingCacheDir();
  const filePath = getEmbeddingCacheFile(entry.hash);
  fs.writeFileSync(filePath, JSON.stringify(entry));
}

function migrateLegacyEmbeddingCache(): void {
  if (legacyCacheChecked) return;
  legacyCacheChecked = true;

  const legacyFile = path.join(getEmbeddingCacheDir(), 'cache.json');
  if (!fs.existsSync(legacyFile)) return;

  try {
    const stats = fs.statSync(legacyFile);
    if (stats.size > LEGACY_CACHE_MAX_MIGRATE_BYTES) {
      fs.renameSync(legacyFile, `${legacyFile}.bak`);
      return;
    }

    const data = JSON.parse(fs.readFileSync(legacyFile, 'utf-8')) as EmbeddingCache[];
    ensureEmbeddingCacheDir();

    for (const item of data) {
      if (!item?.hash || !item.embedding) continue;
      saveEmbeddingEntry({
        hash: item.hash,
        embedding: item.embedding,
        createdAt: item.createdAt ?? Date.now()
      });
    }

    fs.unlinkSync(legacyFile);
  } catch {
    // If migration fails, keep legacy file to avoid data loss
  }
}

function cleanOldCacheEntriesOnDisk(): void {
  const now = Date.now();
  if (now - lastCacheCleanup < CACHE_CLEANUP_INTERVAL_MS) return;
  lastCacheCleanup = now;

  const dir = getEmbeddingCacheDir();
  if (!fs.existsSync(dir)) return;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry === 'cache.json') continue;
    if (entry.endsWith('.bak')) continue;

    const fullPath = path.join(dir, entry);
    try {
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as EmbeddingCache;
      if (!data?.createdAt) continue;
      if (now - data.createdAt > CACHE_MAX_AGE_MS) {
        fs.unlinkSync(fullPath);
      }
    } catch {
      // Ignore bad cache entries
    }
  }
}

export default function (pi: ExtensionAPI) {
  // State - minimal memory footprint
  let openai: OpenAI | null = null;
  let searchHistory: string[] = [];
  const filterCache = new Map<string, string>();

  const updateExtensionEnv = (ctx: ExtensionContext, updates: Record<string, string>): boolean => {
    const updatedEnv = { ...extensionEnv, ...updates };

    try {
      writeExtensionEnv(updatedEnv);
      extensionEnv = updatedEnv;
      syncSearchSettingsFromEnv();
      return true;
    } catch (error) {
      ctx.ui.notify(
        `Failed to write ${ENV_PATH}. ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      return false;
    }
  };

  async function promptForOpenAIKey(ctx: ExtensionContext): Promise<string | null> {
    const selection = await ctx.ui.select(
      "OpenAI API key is required to use semantic search.",
      [
        {
          value: "enter",
          label: "Enter API key",
          description: `Save to ${ENV_PATH}`
        },
        {
          value: "cancel",
          label: "Cancel",
          description: "Configure later"
        }
      ]
    );

    if (selection !== "enter") {
      return null;
    }

    const apiKeyInput = await ctx.ui.input(`Paste your ${ENV_OPENAI_KEY} (starts with sk-):`);
    const apiKey = apiKeyInput?.trim();

    if (!apiKey) {
      ctx.ui.notify("No API key entered.", "error");
      return null;
    }

    if (!updateExtensionEnv(ctx, { [ENV_OPENAI_KEY]: apiKey })) {
      return null;
    }

    ctx.ui.notify(`Saved ${ENV_OPENAI_KEY} to ${ENV_PATH}`, "success");
    return apiKey;
  }

  async function promptForSearchModel(
    ctx: ExtensionContext
  ): Promise<{ provider: string; model: string } | null> {
    const selection = await ctx.ui.select(
      "Select the model used for filtering and search summaries.",
      [
        {
          value: "recommended",
          label: "cerebras / glm-4.7 (best)",
          description: "Best overall balance of speed + quality"
        },
        {
          value: "openai-mini",
          label: "openai / gpt-4o-mini",
          description: "Good quality, slower"
        },
        {
          value: "openai-4o",
          label: "openai / gpt-4o",
          description: "Highest quality, slower/expensive"
        },
        {
          value: "custom",
          label: "Custom provider/model",
          description: "Enter provider + model manually"
        },
        {
          value: "cancel",
          label: "Cancel",
          description: "Configure later"
        }
      ]
    );

    if (!selection || selection === "cancel") {
      return null;
    }

    if (selection === "recommended") {
      return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
    }

    if (selection === "openai-mini") {
      return { provider: "openai", model: "gpt-4o-mini" };
    }

    if (selection === "openai-4o") {
      return { provider: "openai", model: "gpt-4o" };
    }

    const providerInput = await ctx.ui.input("Provider (e.g. cerebras, openai):");
    const provider = providerInput?.trim();
    if (!provider) {
      ctx.ui.notify("Provider is required.", "error");
      return null;
    }

    const modelInput = await ctx.ui.input("Model name (e.g. glm-4.7):");
    const model = modelInput?.trim();
    if (!model) {
      ctx.ui.notify("Model name is required.", "error");
      return null;
    }

    return { provider, model };
  }

  async function ensureSearchModel(ctx: ExtensionContext): Promise<boolean> {
    if (configuredSearchProvider && configuredSearchModel) {
      return true;
    }

    if (IS_SUBAGENT) {
      return true;
    }

    const selection = await promptForSearchModel(ctx);
    if (!selection) {
      ctx.ui.notify("Search model not configured.", "error");
      return false;
    }

    if (!updateExtensionEnv(ctx, {
      [ENV_SEARCH_PROVIDER]: selection.provider,
      [ENV_SEARCH_MODEL]: selection.model
    })) {
      return false;
    }

    ctx.ui.notify(`Saved search model to ${ENV_PATH}`, "success");
    return true;
  }

  // Initialize OpenAI client
  async function initializeOpenAI(ctx: ExtensionContext): Promise<boolean> {
    let apiKey = extensionEnv[ENV_OPENAI_KEY]?.trim() || process.env.OPENAI_API_KEY?.trim();

    if (!apiKey && !IS_SUBAGENT) {
      apiKey = (await promptForOpenAIKey(ctx)) ?? undefined;
    }

    if (!apiKey) {
      ctx.ui.notify(`OpenAI API key not found. Set ${ENV_OPENAI_KEY} in ${ENV_PATH}.`, "error");
      return false;
    }

    if (!openai) {
      openai = new OpenAI({ apiKey });
    }

    if (!await ensureSearchModel(ctx)) {
      return false;
    }

    return true;
  }

  // File discovery and chunking
  async function discoverFiles(
    cwd: string,
    patterns: string[] = DEFAULT_PATTERNS,
    onUpdate?: (message: string) => void
  ): Promise<string[]> {
    const files = new Set<string>();
    const excludes = [
      'node_modules', '.git', 'dist', 'build', 'out', 'target',  // Build outputs
      '.venv', 'venv', '__pycache__', '.pytest_cache',           // Python
      'vendor', '.bundle',                                        // Ruby/Go
      '.next', '.nuxt', '.svelte-kit',                           // JS frameworks
      'coverage', '.nyc_output',                                  // Test coverage
      '.cache', '.parcel-cache', '.turbo',                       // Caches
    ];
    const excludeArgs = excludes.flatMap((dir) => ["-not", "-path", `*/${dir}/*`]);

    const reportProgress = () => {
      if (files.size > 0 && files.size % DISCOVERY_PROGRESS_EVERY === 0) {
        onUpdate?.(`Discovering files... ${files.size} found`);
      }
    };

    for (const pattern of patterns) {
      // Extract extension from glob pattern (e.g., "**/*.ts" -> "*.ts")
      const extension = pattern.replace('**/', '');

      await new Promise<void>((resolve) => {
        const proc = spawn("find", [".", "-name", extension, "-type", "f", ...excludeArgs], {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"]
        });

        const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

        rl.on("line", (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          files.add(path.resolve(cwd, trimmed));
          reportProgress();
        });

        proc.on("error", () => {
          rl.close();
          resolve();
        });

        proc.on("close", () => {
          rl.close();
          resolve();
        });
      });

      await yieldToEventLoop();
    }

    return [...files].sort();
  }

  async function chunkFiles(files: string[]): Promise<FileChunk[]> {
    const chunks: FileChunk[] = [];
    
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const filePath = files[fileIndex];
      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        if (content.length < 50) continue; // Skip very small files
        
        const lines = content.split('\n');
        let currentChunk = '';
        let startLine = 1;
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          
          if (currentChunk.length + line.length > CHUNK_SIZE) {
            // Save current chunk
            if (currentChunk.trim()) {
              const content = currentChunk.trim();
              chunks.push({
                path: filePath,
                content,
                startLine,
                endLine: i,
                contentHash: getContentHash(content),
              });
            }
            
            // Start new chunk with overlap
            const overlapLines = currentChunk.split('\n').slice(-Math.floor(CHUNK_OVERLAP / 50));
            currentChunk = overlapLines.join('\n') + '\n' + line + '\n';
            startLine = Math.max(1, i - overlapLines.length + 1);
          } else {
            currentChunk += line + '\n';
          }
        }
        
        // Save final chunk
        if (currentChunk.trim()) {
          const content = currentChunk.trim();
          chunks.push({
            path: filePath,
            content,
            startLine,
            endLine: lines.length,
            contentHash: getContentHash(content),
          });
        }
      } catch {
        // Skip files that can't be read
      }

      if (fileIndex > 0 && fileIndex % CHUNK_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }
    
    return chunks;
  }

  // Embedding generation with caching
  async function generateEmbeddings(chunks: FileChunk[], onUpdate?: (progress: number, total: number, cached: number) => void): Promise<FileChunk[]> {
    if (!openai) throw new Error("OpenAI not initialized");
    
    const processed: FileChunk[] = [];
    const now = Date.now();
    
    ensureEmbeddingCacheDir();
    migrateLegacyEmbeddingCache();
    cleanOldCacheEntriesOnDisk();

    const embeddingCache = new Map<string, EmbeddingCache>();
    
    // Separate cached and uncached chunks
    const cachedChunks: FileChunk[] = [];
    const uncachedChunks: FileChunk[] = [];
    
    for (const chunk of chunks) {
      if (!chunk.contentHash) {
        chunk.contentHash = getContentHash(chunk.content);
      }
      
      let cached = embeddingCache.get(chunk.contentHash);
      if (!cached) {
        cached = loadEmbeddingEntry(chunk.contentHash);
        if (cached) {
          embeddingCache.set(chunk.contentHash, cached);
        }
      }

      if (cached) {
        cachedChunks.push({
          ...chunk,
          embedding: cached.embedding,
          indexedAt: now,
        });
      } else {
        uncachedChunks.push(chunk);
      }
    }
    
    // Process cached chunks immediately
    processed.push(...cachedChunks);
    
    // Report cache hits
    if (cachedChunks.length > 0) {
      onUpdate?.(processed.length, chunks.length, cachedChunks.length);
    }

    // Generate embeddings for uncached chunks in parallel
    if (uncachedChunks.length > 0) {
      // Create batches with both token AND chunk count limits
      const batches: FileChunk[][] = [];
      let currentBatch: FileChunk[] = [];
      let currentTokens = 0;
      
      for (const chunk of uncachedChunks) {
        // Very conservative token estimate: ~2 chars per token for code (accounts for special tokens)
        const chunkTokens = Math.ceil(chunk.content.length / 2);
        
        // If single chunk exceeds limit, truncate its content
        if (chunkTokens > MAX_BATCH_TOKENS) {
          // Truncate oversized chunks to fit within limit
          const maxChars = MAX_BATCH_TOKENS * 2;
          const truncatedContent = chunk.content.substring(0, maxChars);
          const truncatedChunk = {
            ...chunk,
            content: truncatedContent,
            contentHash: getContentHash(truncatedContent)
          };
          if (currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentTokens = 0;
          }
          batches.push([truncatedChunk]);
          continue;
        }
        
        // Check both token limit AND chunk count limit
        const wouldExceedTokens = currentTokens + chunkTokens > MAX_BATCH_TOKENS;
        const wouldExceedChunks = currentBatch.length >= MAX_CHUNKS_PER_BATCH;
        
        if ((wouldExceedTokens || wouldExceedChunks) && currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentTokens = 0;
        }
        
        currentBatch.push(chunk);
        currentTokens += chunkTokens;
      }
      
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      
      // Process batches in parallel with concurrency limit
      let completedBatches = 0;
      const processBatch = async (batch: FileChunk[]): Promise<FileChunk[]> => {
        try {
          const response = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: batch.map(c => c.content),
          });
          
          const results: FileChunk[] = [];
          for (let j = 0; j < batch.length; j++) {
            const chunk = batch[j];
            const embedding = response.data[j].embedding;
            
            results.push({
              ...chunk,
              embedding,
              indexedAt: now,
            });
            
            // Cache the new embedding
            const entry = {
              hash: chunk.contentHash!,
              embedding,
              createdAt: now
            };
            embeddingCache.set(chunk.contentHash!, entry);
            saveEmbeddingEntry(entry);
          }
          
          completedBatches++;
          const processedCount = cachedChunks.length + results.length + processed.filter(c => c.embedding).length;
          onUpdate?.(Math.min(processedCount + (completedBatches * 20), chunks.length), chunks.length, cachedChunks.length);
          
          return results;
        } catch (error) {
          console.error("Error generating embeddings for batch:", error);
          // Return chunks without embeddings on error
          return batch.map(c => ({ ...c, indexedAt: now }));
        }
      };
      
      // Run all batches in parallel (with concurrency limit)
      const batchResults = await runWithConcurrency(
        batches.map(batch => () => processBatch(batch)),
        MAX_PARALLEL_REQUESTS
      );
      
      // Flatten results and add to processed
      for (const result of batchResults) {
        processed.push(...result);
      }
      
    }
    
    return processed;
  }

  // Similarity search
  function cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async function semanticSearch(cwd: string, query: string, topK: number = 12): Promise<SearchResult[]> {
    if (!openai) throw new Error("OpenAI not initialized");
    
    // Generate query embedding
    const queryResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    
    const queryEmbedding = queryResponse.data[0].embedding;
    
    // Use a min-heap to keep only top K results (memory efficient)
    const results: SearchResult[] = [];
    
    // Stream through chunks - don't hold all in memory
    for await (const chunk of streamChunks(cwd)) {
      if (!chunk.embedding) continue;
      
      const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (similarity > 0.3) {
        const excerpt = chunk.content.substring(0, 200) + 
          (chunk.content.length > 200 ? "..." : "");
        
        results.push({
          chunk,
          score: similarity,
          excerpt: excerpt.replace(/\n/g, ' ').trim(),
        });
        
        // Keep only top results to limit memory
        if (results.length > topK * 2) {
          results.sort((a, b) => b.score - a.score);
          results.length = topK;
        }
      }
    }
    
    // Final sort and trim
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // Index management
  function saveIndex(cwd: string, chunks: FileChunk[], metadata: IndexMetadata): void {
    if (!fs.existsSync(getIndexDir(cwd))) {
      fs.mkdirSync(getIndexDir(cwd), { recursive: true });
    }
    
    // Build file index times map
    const fileIndexTimes: Record<string, number> = {};
    for (const chunk of chunks) {
      if (chunk.indexedAt && !fileIndexTimes[chunk.path]) {
        fileIndexTimes[chunk.path] = chunk.indexedAt;
      }
    }
    
    // Update metadata with file index times
    metadata.lastUpdated = Date.now();
    metadata.fileIndexTimes = fileIndexTimes;
    
    // Save chunks (JSONL for streaming reads)
    const chunksFile = path.join(getIndexDir(cwd), CHUNKS_JSONL);
    writeChunksJsonlSync(chunksFile, chunks);
    
    // Save metadata
    const metaFile = path.join(getIndexDir(cwd), 'metadata.json');
    fs.writeFileSync(metaFile, JSON.stringify(metadata));
  }

  function loadIndexMetadata(cwd: string): IndexMetadata | null {
    const metaFile = path.join(getIndexDir(cwd), 'metadata.json');
    if (!fs.existsSync(metaFile)) return null;
    
    try {
      const raw = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as Partial<IndexMetadata>;
      return {
        version: raw.version ?? "1.0.0",
        createdAt: raw.createdAt ?? Date.now(),
        lastUpdated: raw.lastUpdated ?? raw.createdAt ?? Date.now(),
        fileCount: raw.fileCount ?? 0,
        chunkCount: raw.chunkCount ?? 0,
        paths: raw.paths ?? [],
        patterns: raw.patterns ?? DEFAULT_PATTERNS,
        fileIndexTimes: raw.fileIndexTimes ?? {}
      };
    } catch {
      return null;
    }
  }

  function indexExists(cwd: string): boolean {
    const chunksJsonl = path.join(getIndexDir(cwd), CHUNKS_JSONL);
    const chunksJson = path.join(getIndexDir(cwd), CHUNKS_JSON);
    const metaFile = path.join(getIndexDir(cwd), 'metadata.json');
    return fs.existsSync(metaFile) && (fs.existsSync(chunksJsonl) || fs.existsSync(chunksJson));
  }

  function indexHasEmbeddings(cwd: string): boolean {
    // Check if the first chunk has an embedding - if not, index is corrupted
    const info = getChunksFileInfo(cwd);
    if (!info) return false;

    try {
      if (info.format === "jsonl") {
        const content = fs.readFileSync(info.path, "utf-8");
        const firstLine = content.split("\n").find(l => l.trim());
        if (!firstLine) return false;
        const chunk = JSON.parse(firstLine) as FileChunk;
        return Array.isArray(chunk.embedding) && chunk.embedding.length > 0;
      }
      
      const chunks = JSON.parse(fs.readFileSync(info.path, "utf-8")) as FileChunk[];
      if (chunks.length === 0) return false;
      return Array.isArray(chunks[0].embedding) && chunks[0].embedding.length > 0;
    } catch {
      return false;
    }
  }

  // Stream chunks from disk for search - avoid loading the full index into memory
  async function* streamChunks(cwd: string): AsyncGenerator<FileChunk> {
    const info = getChunksFileInfo(cwd);
    if (!info) return;

    if (info.format === "jsonl") {
      const input = fs.createReadStream(info.path, { encoding: "utf-8" });
      const rl = readline.createInterface({ input, crlfDelay: Infinity });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as FileChunk;
        } catch {
          // Skip malformed lines
        }
      }

      return;
    }

    // Legacy JSON array format
    try {
      const chunks: FileChunk[] = JSON.parse(fs.readFileSync(info.path, 'utf-8'));
      const jsonlPath = path.join(getIndexDir(cwd), CHUNKS_JSONL);
      if (!fs.existsSync(jsonlPath)) {
        try {
          writeChunksJsonlSync(jsonlPath, chunks);
        } catch {
          // Best-effort migration
        }
      }

      for (const chunk of chunks) {
        yield chunk;
      }
    } catch {
      return;
    }
  }

  function normalizeMode(mode?: string): string {
    const value = (mode ?? DEFAULT_MODE).trim();
    return value.length > 0 ? value : DEFAULT_MODE;
  }

  function resolvePatternsForMode(mode: string): string[] {
    if (mode === "code") return DEFAULT_PATTERNS;
    return DEFAULT_PATTERNS;
  }

  function normalizeQueryExtrapolation(mainQuery: string, extrapolation?: string[]): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    const mainKey = mainQuery.trim().toLowerCase();
    if (mainKey) {
      seen.add(mainKey);
    }

    for (const item of extrapolation ?? []) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(trimmed);
    }

    return normalized;
  }

  function mergeQueryMatches(queryMatches: Array<{ query: string; matches: FileMatch[] }>): CombinedFileMatch[] {
    const combined = new Map<string, CombinedFileMatch>();

    for (const { query, matches } of queryMatches) {
      for (const match of matches) {
        const existing = combined.get(match.absolutePath);
        if (existing) {
          if (!existing.queries.includes(query)) {
            existing.queries.push(query);
          }
          if (match.score > existing.score) {
            existing.score = match.score;
            existing.startLine = match.startLine;
            existing.endLine = match.endLine;
            existing.snippet = match.snippet;
          }
          continue;
        }

        combined.set(match.absolutePath, {
          ...match,
          queries: [query]
        });
      }
    }

    return [...combined.values()].sort((a, b) => b.score - a.score);
  }

  function formatQueryExtrapolationLines(queries: string[]): string {
    if (queries.length === 0) return "";
    const lines = queries.map((query) => `- "${query}"`).join("\n");
    return `Extrapolated queries:\n${lines}\n`;
  }

  function formatMatchList(matches: FileMatch[], maxTotalChars: number): string {
    const lines: string[] = [];
    let totalChars = 0;

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const header = `${i + 1}. ${match.path}:${match.startLine}-${match.endLine} (${(match.score * 100).toFixed(1)}% match)`;
      const block = `${header}\n${match.snippet}`;
      if (totalChars + block.length > maxTotalChars && lines.length > 0) {
        break;
      }
      lines.push(block);
      totalChars += block.length;
    }

    return lines.join('\n\n');
  }

  function formatMatchFileList(matches: FileMatch[]): string {
    return matches
      .map(
        (match) =>
          `- ${match.path}:${match.startLine}-${match.endLine} (${(match.score * 100).toFixed(1)}% match)`
      )
      .join('\n');
  }

  async function ensureIndex(
    cwd: string,
    patterns: string[],
    onUpdate?: (message: string) => void
  ): Promise<IndexMetadata> {
    const existingMeta = loadIndexMetadata(cwd);
    if (existingMeta && indexExists(cwd)) {
      // Verify the index has valid embeddings, not just files
      if (indexHasEmbeddings(cwd)) {
        return existingMeta;
      }
      onUpdate?.("Index exists but has no embeddings. Rebuilding...");
    }

    onUpdate?.("Discovering files...");
    await yieldToEventLoop();
    const files = await discoverFiles(cwd, patterns, onUpdate);
    if (files.length === 0) {
      throw new Error("No files found matching patterns.");
    }

    onUpdate?.(`Found ${files.length} files. Chunking...`);
    const chunks = await chunkFiles(files);

    onUpdate?.(`Created ${chunks.length} chunks. Generating embeddings...`);
    const chunksWithEmbeddings = await generateEmbeddings(
      chunks,
      (progress, total, cached) => {
        const cacheInfo = cached > 0 ? ` (${cached} cached)` : '';
        onUpdate?.(`Generating embeddings: ${progress}/${total}${cacheInfo}`);
      }
    );

    const metadata: IndexMetadata = {
      version: "1.0.0",
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      fileCount: files.length,
      chunkCount: chunksWithEmbeddings.length,
      paths: [],
      patterns
    };

    saveIndex(cwd, chunksWithEmbeddings, metadata);
    return metadata;
  }

  async function embeddingSearchByFile(
    cwd: string,
    query: string,
    pathFilter: string | undefined,
    topK: number
  ): Promise<FileMatch[]> {
    if (!openai) throw new Error("OpenAI not initialized");

    const queryResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });

    const queryEmbedding = queryResponse.data[0].embedding;
    const matchesByFile = new Map<string, FileMatch>();
    const matchPath = createPathFilter(cwd, pathFilter);
    const limit = Math.max(1, topK);

    for await (const chunk of streamChunks(cwd)) {
      if (!chunk.embedding) continue;
      if (!matchPath(chunk.path)) continue;

      const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (similarity < MIN_SIMILARITY) continue;

      const absolutePath = path.resolve(chunk.path);
      const existing = matchesByFile.get(absolutePath);
      if (!existing || similarity > existing.score) {
        matchesByFile.set(absolutePath, {
          path: path.relative(cwd, chunk.path),
          absolutePath,
          score: similarity,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          snippet: formatSnippet(chunk.content, MAX_PREVIEW_SNIPPET_CHARS)
        });
      }
    }

    return [...matchesByFile.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  function buildSearchAgentPrompt(
    query: string,
    pathFilter: string | undefined,
    mode: string,
    preview: string,
    queryExtrapolation: string[]
  ): string {
    const pathLine = pathFilter ? `Path filter: ${pathFilter}` : "Path filter: (none)";
    const extrapolationLines = formatQueryExtrapolationLines(queryExtrapolation);
    return `Query: "${query}"
${extrapolationLines}${pathLine}
Mode: ${mode}

Semantic preview (ranked, one snippet per file, combined across queries):
${preview}

Task:
- Answer the query if possible.
- Otherwise list the most relevant files and why.
- Use local_embedding_search to expand the semantic list when needed.
- Do not write or modify files.

Return a short answer and a file list.`;
  }

  pi.registerTool({
    name: "local_embedding_search",
    label: "Local Embedding Search",
    description: "Run embedding search over the local index (one result per file).",
    parameters: Type.Object({
      query: Type.String({ description: "Search query in natural language" }),
      cwd: Type.Optional(Type.String({
        description: "Directory to search (uses that directory's index). Can be absolute or relative to current working directory."
      })),
      path: Type.Optional(Type.String({
        description: "Filter results to files matching this path within the searched directory. Does NOT change which directory is searched - use 'cwd' for that."
      })),
      mode: Type.Optional(Type.String({
        description: "Search mode (default: code). Currently ignored; code includes markdown."
      }))
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      if (!await initializeOpenAI(ctx)) {
        return {
          content: [{
            type: "text",
            text: "Failed to initialize OpenAI client."
          }],
          isError: true
        };
      }

      // Resolve cwd: use param if provided, otherwise ctx.cwd
      const cwd = params.cwd 
        ? path.resolve(ctx.cwd, expandTilde(params.cwd))
        : ctx.cwd;
      const mode = normalizeMode(params.mode);
      const patterns = resolvePatternsForMode(mode);
      const pathFilter = params.path?.trim() || undefined;

      onUpdate?.({
        content: [{
          type: "text",
          text: "Ensuring index exists..."
        }]
      });

      try {
        await ensureIndex(cwd, patterns, (message) => {
          onUpdate?.({ content: [{ type: "text", text: message }] });
        });
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: error instanceof Error ? error.message : String(error)
          }],
          isError: true
        };
      }

      onUpdate?.({
        content: [{
          type: "text",
          text: "Searching embeddings..."
        }]
      });

      const matches = await embeddingSearchByFile(cwd, params.query, pathFilter, DEFAULT_TOP_K);

      if (matches.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No embedding matches found for "${params.query}".`
          }],
          details: {
            query: params.query,
            mode,
            path: pathFilter,
            matches: []
          }
        };
      }

      const preview = formatMatchList(matches, MAX_PREVIEW_TOTAL_CHARS);

      const resultText = `Embedding search results for: "${params.query}"
Path filter: ${pathFilter ?? "(none)"}
Mode: ${mode}

${preview}`;

      return {
        content: [{
          type: "text",
          text: resultText
        }],
        details: {
          query: params.query,
          mode,
          path: pathFilter,
          matches: matches.map((match) => ({
            path: match.path,
            score: match.score,
            startLine: match.startLine,
            endLine: match.endLine
          }))
        }
      };
    },
  });

  if (!IS_SUBAGENT) {
    pi.registerTool({
      name: "search_agent",
      label: "Search Agent",
      description: "Search locally and use a search subagent to refine results, with optional query extrapolation.",
      parameters: Type.Object({
        query: Type.String({ description: "Main search query in natural language" }),
        cwd: Type.Optional(Type.String({
          description: "Directory to search (uses that directory's index). Can be absolute or relative to current working directory."
        })),
        queryExtrapolation: Type.Optional(Type.Array(Type.String(), {
          description: "Additional queries to run and merge with the main query",
          default: []
        })),
        path: Type.Optional(Type.String({
          description: "Filter results to files matching this path within the searched directory. Does NOT change which directory is searched - use 'cwd' for that."
        })),
        mode: Type.Optional(Type.String({
          description: "Search mode (default: code). Currently ignored; code includes markdown."
        })),
        logSubagent: Type.Optional(Type.Boolean({
          description: "Write subagent JSON session log to disk",
          default: false
        }))
      }),

      async execute(toolCallId, params, onUpdate, ctx, signal) {
        if (!await initializeOpenAI(ctx)) {
          return {
            content: [{
              type: "text",
              text: "Failed to initialize OpenAI client."
            }],
            isError: true
          };
        }

        // Resolve cwd: use param if provided, otherwise ctx.cwd
        const cwd = params.cwd 
          ? path.resolve(ctx.cwd, expandTilde(params.cwd))
          : ctx.cwd;
        const mode = normalizeMode(params.mode);
        const patterns = resolvePatternsForMode(mode);
        const pathFilter = params.path?.trim() || undefined;
        const logSubagent = params.logSubagent ?? false;
        const subagentLogPath = logSubagent ? createSubagentLogPath() : undefined;

        onUpdate?.({
          content: [{
            type: "text",
            text: "Ensuring index exists..."
          }]
        });

        try {
          await ensureIndex(cwd, patterns, (message) => {
            onUpdate?.({ content: [{ type: "text", text: message }] });
          });
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: error instanceof Error ? error.message : String(error)
            }],
            isError: true
          };
        }

        const extrapolatedQueries = normalizeQueryExtrapolation(params.query, params.queryExtrapolation);
        const searchQueries = [params.query, ...extrapolatedQueries];
        const searchMessage = searchQueries.length > 1
          ? `Searching embeddings for ${searchQueries.length} queries...`
          : "Searching embeddings...";

        onUpdate?.({
          content: [{
            type: "text",
            text: searchMessage
          }]
        });

        const queryMatches: Array<{ query: string; matches: FileMatch[] }> = [];

        for (const query of searchQueries) {
          const matches = await embeddingSearchByFile(cwd, query, pathFilter, DEFAULT_TOP_K);
          if (matches.length > 0) {
            queryMatches.push({ query, matches });
          }
        }

        if (queryMatches.length === 0) {
          const noMatchText = extrapolatedQueries.length > 0
            ? `No embedding matches found for "${params.query}" or extrapolated queries.`
            : `No embedding matches found for "${params.query}".`;

          return {
            content: [{
              type: "text",
              text: noMatchText
            }],
            details: {
              query: params.query,
              queryExtrapolation: extrapolatedQueries,
              mode,
              path: pathFilter,
              matches: []
            }
          };
        }

        const combinedMatches = mergeQueryMatches(queryMatches);
        const preview = formatMatchList(combinedMatches, MAX_PREVIEW_TOTAL_CHARS);
        const prompt = buildSearchAgentPrompt(params.query, pathFilter, mode, preview, extrapolatedQueries);

        onUpdate?.({
          content: [{
            type: "text",
            text: "Running search agent..."
          }]
        });

        let agentOutput = "";
        let agentLogPath = subagentLogPath;
        let agentUsage: UsageTotals | undefined;
        try {
          const agentResult = await callSearchAgent(prompt, cwd, signal, {
            logFile: subagentLogPath,
            captureUsage: true
          });
          agentOutput = agentResult.output;
          agentLogPath = agentResult.logFile;
          agentUsage = agentResult.usage;
        } catch (error) {
          agentOutput = error instanceof Error ? error.message : String(error);
        }

        const extrapolationLines = formatQueryExtrapolationLines(extrapolatedQueries);
        const filesList = formatMatchFileList(combinedMatches);
        const logLine = agentLogPath ? `\n\nSubagent log:\n${agentLogPath}` : "";
        const costLine = formatUsageCostLine(agentUsage);
        const costSection = costLine ? `\n\n${costLine}` : "";

        const resultText = `Query: "${params.query}"
${extrapolationLines}Path filter: ${pathFilter ?? "(none)"}
Mode: ${mode}

Embedding preview (combined across queries):
${preview}

Search agent:
${agentOutput}${logLine}${costSection}

Relevant files:
${filesList}`;

        return {
          content: [{
            type: "text",
            text: resultText
          }],
          details: {
            query: params.query,
            queryExtrapolation: extrapolatedQueries,
            mode,
            path: pathFilter,
            matches: combinedMatches.map((match) => ({
              path: match.path,
              score: match.score,
              startLine: match.startLine,
              endLine: match.endLine
            })),
            searchAgentOutput: agentOutput,
            subagentLogPath: agentLogPath,
            searchAgentUsage: agentUsage
          }
        };
      },
    });
  }

  // Register semantic_index tool
  if (ENABLE_LEGACY_TOOLS) {
    pi.registerTool({
    name: "semantic_index",
    label: "Semantic Index",
    description: "Create semantic index of codebase for intelligent search",
    parameters: Type.Object({
      paths: Type.Optional(Type.Array(Type.String({
        description: "Specific paths to index (default: all supported files)"
      }))),
      patterns: Type.Optional(Type.Array(Type.String({
        description: "File patterns to include",
        default: DEFAULT_PATTERNS
      }))),
      force: Type.Optional(Type.Boolean({
        description: "Force rebuild existing index",
        default: false
      }))
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      if (!await initializeOpenAI(ctx)) {
        return {
          content: [{ 
            type: "text", 
            text: "Failed to initialize OpenAI client. Check OPENAI_API_KEY." 
          }],
          isError: true
        };
      }

      const cwd = ctx.cwd;
      
      // Check if index exists
      const existingMeta = loadIndexMetadata(cwd);
      if (existingMeta && indexExists(cwd) && !params.force) {
        return {
          content: [{ 
            type: "text", 
            text: `Index already exists for ${cwd}\nCreated: ${new Date(existingMeta.createdAt).toLocaleString()}\nFiles: ${existingMeta.fileCount}\nChunks: ${existingMeta.chunkCount}\n\nUse force: true to rebuild.` 
          }],
          details: existingMeta
        };
      }

      onUpdate?.({ content: [{ type: "text", text: "🔍 Discovering files..." }] });
      await yieldToEventLoop();

      // Discover files
      const files = await discoverFiles(cwd, params.patterns, (message) => {
        onUpdate?.({ content: [{ type: "text", text: `🔍 ${message}` }] });
      });
      if (files.length === 0) {
        return {
          content: [{ 
            type: "text", 
            text: "No files found matching patterns. Try different patterns." 
          }]
        };
      }

      onUpdate?.({ 
        content: [{ 
          type: "text", 
          text: `📁 Found ${files.length} files. Chunking...` 
        }] 
      });

      // Chunk files
      const chunks = await chunkFiles(files);
      
      onUpdate?.({ 
        content: [{ 
          type: "text", 
          text: `🔪 Created ${chunks.length} chunks. Generating embeddings...` 
        }] 
      });

      // Generate embeddings
      const chunksWithEmbeddings = await generateEmbeddings(
        chunks,
        (progress, total, cached) => {
          const cacheInfo = cached > 0 ? ` (${cached} cached)` : '';
          onUpdate?.({ 
            content: [{ 
              type: "text", 
              text: `🧠 Generating embeddings: ${progress}/${total} (${Math.round(progress/total*100)}%)${cacheInfo}` 
            }] 
          });
        }
      );

      // Save index
      const metadata: IndexMetadata = {
        version: "1.0.0",
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        fileCount: files.length,
        chunkCount: chunksWithEmbeddings.length,
        paths: params.paths || [],
        patterns: params.patterns || DEFAULT_PATTERNS
      };
      
      saveIndex(cwd, chunksWithEmbeddings, metadata);

      return {
        content: [{ 
          type: "text", 
          text: `✅ Semantic index created!\n\n📊 Statistics:\n• Files indexed: ${files.length}\n• Chunks created: ${chunksWithEmbeddings.length}\n• Embedding model: text-embedding-3-small\n\nUse semantic_search tool to search.` 
        }],
        details: metadata
      };
    },

    renderCall(args, theme) {
      const patterns = args.patterns?.slice(0, 3).join(', ') || 'default';
      const forceText = args.force ? ' (forced)' : '';
      return new Text(
        theme.fg("toolTitle", "🔍 semantic_index ") +
        theme.fg("muted", `patterns: ${patterns}${forceText}`),
        0, 0
      );
    },

    renderResult(result, options, theme) {
      const details = result.details as IndexMetadata | undefined;
      if (!details) {
        return new Text(theme.fg("success", "✓ Index created"), 0, 0);
      }

      const fileCount = details.fileCount ?? 0;
      const chunkCount = details.chunkCount ?? 0;
      
      return new Text(
        theme.fg("success", "✓ Indexed ") +
        theme.fg("dim", `${fileCount} files, ${chunkCount} chunks`),
        0, 0
      );
    },
  });
  }

  // Incremental index update
  async function updateIndexIncrementally(
    cwd: string, 
    patterns: string[] = DEFAULT_PATTERNS,
    onUpdate?: (message: string) => void
  ): Promise<{ added: number, updated: number, deleted: number }> {
    const existingMeta = loadIndexMetadata(cwd);
    
    if (!existingMeta) {
      // No existing index, create new one
      onUpdate?.("No existing index found, creating new index...");
      const files = await discoverFiles(cwd, patterns, onUpdate);
      const chunks = await chunkFiles(files);
      const chunksWithEmbeddings = await generateEmbeddings(chunks);
      
      const metadata: IndexMetadata = {
        version: "1.0.0",
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        fileCount: files.length,
        chunkCount: chunksWithEmbeddings.length,
        paths: [],
        patterns
      };
      
      saveIndex(cwd, chunksWithEmbeddings, metadata);
      return { added: chunksWithEmbeddings.length, updated: 0, deleted: 0 };
    }

    // Check for new/modified/deleted files
    onUpdate?.("Checking for file changes...");
    const currentFiles = await discoverFiles(cwd, patterns, onUpdate);
    const currentFilesSet = new Set(currentFiles);
    
    // Get old files from metadata's fileIndexTimes (don't load all chunks)
    const fileIndexTimes = existingMeta.fileIndexTimes || {};
    const oldFiles = new Set(Object.keys(fileIndexTimes));
    
    const newFiles = currentFiles.filter(f => !oldFiles.has(f));
    const deletedFiles = [...oldFiles].filter(f => !currentFilesSet.has(f));
    const modifiedFiles: string[] = [];
    
    // Check for modified files
    for (const file of currentFiles) {
      if (newFiles.includes(file)) continue;
      try {
        const stats = fs.statSync(file);
        const indexedTime = fileIndexTimes[file] || existingMeta.createdAt;
        if (stats.mtimeMs > indexedTime) {
          modifiedFiles.push(file);
        }
      } catch {
        deletedFiles.push(file);
      }
    }

    if (newFiles.length === 0 && modifiedFiles.length === 0 && deletedFiles.length === 0) {
      onUpdate?.("Index is up to date");
      return { added: 0, updated: 0, deleted: 0 };
    }

    // Only now load existing chunks (we need to modify the index)
    const existingChunks = loadAllChunks(cwd);

    // Remove old chunks for modified and deleted files
    const filesToRemove = new Set([...modifiedFiles, ...deletedFiles]);
    const updatedChunks = existingChunks.filter(c => !filesToRemove.has(c.path));
    
    if (deletedFiles.length > 0) {
      onUpdate?.(`Removing ${deletedFiles.length} deleted files from index...`);
    }

    // Process new files
    onUpdate?.(`Processing ${newFiles.length} new files...`);
    const newChunks = await chunkFiles(newFiles);
    const newChunksWithEmbeddings = await generateEmbeddings(newChunks);

    // Process modified files
    onUpdate?.(`Processing ${modifiedFiles.length} modified files...`);
    const modifiedChunks = await chunkFiles(modifiedFiles);
    const modifiedChunksWithEmbeddings = await generateEmbeddings(modifiedChunks);

    // Combine chunks
    const allChunks = [...updatedChunks, ...newChunksWithEmbeddings, ...modifiedChunksWithEmbeddings];

    // Save updated index
    const updatedMetadata: IndexMetadata = {
      ...existingMeta,
      lastUpdated: Date.now(),
      fileCount: currentFiles.length,
      chunkCount: allChunks.length
    };

    saveIndex(cwd, allChunks, updatedMetadata);
    
    onUpdate?.(`Index updated: +${newChunksWithEmbeddings.length} new, ~${modifiedChunksWithEmbeddings.length} modified, -${deletedFiles.length} deleted`);
    
    return { 
      added: newChunksWithEmbeddings.length, 
      updated: modifiedChunksWithEmbeddings.length,
      deleted: deletedFiles.length
    };
  }

  // Register semantic_search tool
  if (ENABLE_LEGACY_TOOLS) {
    pi.registerTool({
    name: "semantic_search",
    label: "Semantic Search",
    description: "Search codebase semantically with automatic index updates",
    parameters: Type.Object({
      query: Type.String({ description: "Search query in natural language" }),
      topK: Type.Optional(Type.Number({ 
        description: "Maximum embedding results to consider",
        default: 12 
      })),
      maxParallelFilters: Type.Optional(Type.Number({ 
        description: "Maximum files to filter in parallel",
        default: 4 
      })),
      forceUpdate: Type.Optional(Type.Boolean({
        description: "Force full index rebuild",
        default: false
      }))
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      if (!await initializeOpenAI(ctx)) {
        return {
          content: [{ 
            type: "text", 
            text: "Failed to initialize OpenAI client." 
          }],
          details: { query: params.query, embeddingMatches: 0, relevantFiles: [] },
          isError: true
        };
      }

      const cwd = ctx.cwd;
      
      // Always update index (or load existing)
      onUpdate?.({ 
        content: [{ 
          type: "text", 
          text: `🔄 Ensuring index is up to date...` 
        }] 
      });

      let updateResult: { added: number, updated: number, deleted: number };
      
      if (params.forceUpdate) {
        // Force full rebuild
        onUpdate?.({ 
          content: [{ 
            type: "text", 
            text: `🔨 Force rebuilding index...` 
          }] 
        });
        await yieldToEventLoop();

        const files = await discoverFiles(cwd, DEFAULT_PATTERNS, (message) => {
          onUpdate?.({ content: [{ type: "text", text: `🔍 ${message}` }] });
        });
        const chunks = await chunkFiles(files);
        
        onUpdate?.({ 
          content: [{ 
            type: "text", 
            text: `📊 Found ${files.length} files, ${chunks.length} chunks` 
          }] 
        });
        
        const chunksWithEmbeddings = await generateEmbeddings(
          chunks,
          (progress, total, cached) => {
            const cacheInfo = cached > 0 ? ` (${cached} cached)` : '';
            onUpdate?.({ 
              content: [{ 
                type: "text", 
                text: `🧠 Generating embeddings: ${progress}/${total} (${Math.round(progress/total*100)}%)${cacheInfo}` 
              }] 
            });
          }
        );
        
        const metadata: IndexMetadata = {
          version: "1.0.0",
          createdAt: Date.now(),
          lastUpdated: Date.now(),
          fileCount: files.length,
          chunkCount: chunksWithEmbeddings.length,
          paths: [],
          patterns: DEFAULT_PATTERNS
        };
        
        saveIndex(cwd, chunksWithEmbeddings, metadata);
        updateResult = { added: chunksWithEmbeddings.length, updated: 0, deleted: 0 };
      } else {
        // Incremental update
        updateResult = await updateIndexIncrementally(
          cwd, 
          DEFAULT_PATTERNS,
          (message) => onUpdate?.({ content: [{ type: "text", text: message }] })
        );
      }

      onUpdate?.({ 
        content: [{ 
          type: "text", 
          text: `🔍 Searching: "${params.query}"` 
        }] 
      });

      // Step 1: Embedding search ranking
      const embeddingResults = await semanticSearch(cwd, params.query, params.topK ?? 12);
      
      if (embeddingResults.length === 0) {
        return {
          content: [{ 
            type: "text", 
            text: `No semantic matches found for "${params.query}"\n\nTry different keywords or check if the relevant code is indexed.` 
          }],
          details: { query: params.query, embeddingMatches: 0, relevantFiles: [] }
        };
      }

      onUpdate?.({ 
        content: [{ 
          type: "text", 
          text: `📋 Found ${embeddingResults.length} embedding matches. Filtering with GLM...` 
        }] 
      });

      // Add to search history
      searchHistory.unshift(params.query);
      if (searchHistory.length > 10) searchHistory.pop();

      // Step 2: Parallel GLM relevance filtering
      const filterModel = getSearchModelLabel();
      const summaryModel = getSearchModelLabel();
      const maxParallelFilters = params.maxParallelFilters ?? 4;
      
      // Group chunks by file for filtering
      const fileChunks = new Map<string, SearchResult[]>();
      for (const result of embeddingResults) {
        const existing = fileChunks.get(result.chunk.path) || [];
        existing.push(result);
        fileChunks.set(result.chunk.path, existing);
      }
      
      const filesToFilter = Array.from(fileChunks.entries()).slice(0, maxParallelFilters);
      
      onUpdate?.({ 
        content: [{ 
          type: "text", 
          text: `🤖 Filtering ${filesToFilter.length} files in parallel with ${filterModel}...` 
        }] 
      });

      // Parallel filter with pi --print (with concurrency limit)
      let completedFilters = 0;
      const concurrencyLimit = Math.min(10, filesToFilter.length || 1);

      const queryHash = getContentHash(params.query);
      const filterTasks = filesToFilter.map(([filePath, chunks]) => async () => {
        const relativePath = path.relative(ctx.cwd, filePath);
        const rankedChunks = [...chunks]
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_FILTER_CHUNKS_PER_FILE);

        let totalChars = 0;
        const sections: string[] = [];
        for (const item of rankedChunks) {
          let snippet = item.chunk.content;
          if (snippet.length > MAX_FILTER_CHARS_PER_CHUNK) {
            snippet = `${snippet.substring(0, MAX_FILTER_CHARS_PER_CHUNK)}...`;
          }
          const section = `Lines ${item.chunk.startLine}-${item.chunk.endLine}:\n${snippet}`;
          if (totalChars + section.length > MAX_FILTER_TOTAL_CHARS && sections.length > 0) {
            break;
          }
          sections.push(section);
          totalChars += section.length;
        }

        if (sections.length === 0) {
          const fallback = chunks[0];
          sections.push(`Lines ${fallback.chunk.startLine}-${fallback.chunk.endLine}:\n${fallback.chunk.content.substring(0, MAX_FILTER_CHARS_PER_CHUNK)}...`);
        }

        const fileContent = sections.join('\n\n---\n\n');
        const contentHash = getContentHash(fileContent);
        const cacheKey = `${queryHash}:${relativePath}:${contentHash}`;
        const cached = filterCache.get(cacheKey);
        if (cached) {
          completedFilters++;
          onUpdate?.({ 
            content: [{ 
              type: "text", 
              text: `🤖 Filtering: ${completedFilters}/${filesToFilter.length} files processed` 
            }] 
          });

          if (cached === 'NOT_RELEVANT') {
            return null;
          }

          return {
            path: relativePath,
            relevantContent: cached,
            score: chunks[0].score
          };
        }

        const filterPrompt = `You are evaluating if a file is relevant to a search query.

QUERY: "${params.query}"

FILE: ${relativePath}
CONTENT (top relevant snippets, truncated):
${fileContent}

TASK: Determine if this file contains information relevant to the query.
If relevant, extract the specific relevant parts (code snippets, explanations).
If not relevant, say "NOT_RELEVANT".

Be concise. Only include actually relevant content.`;

        let output: { path: string; relevantContent: string; score: number } | null = null;

        try {
          const result = await callLLM(filterPrompt, ctx.cwd, signal);
          if (!result.includes('NOT_RELEVANT')) {
            output = {
              path: relativePath,
              relevantContent: result,
              score: chunks[0].score
            };
            filterCache.set(cacheKey, result);
          } else {
            filterCache.set(cacheKey, 'NOT_RELEVANT');
          }
        } catch {
          // On error, include the file with raw content
          output = {
            path: relativePath,
            relevantContent: fileContent.substring(0, 500) + '...',
            score: chunks[0].score
          };
        } finally {
          if (filterCache.size > 2000) {
            filterCache.clear();
          }

          completedFilters++;
          onUpdate?.({ 
            content: [{ 
              type: "text", 
              text: `🤖 Filtering: ${completedFilters}/${filesToFilter.length} files processed` 
            }] 
          });
        }

        return output;
      });

      const filterResults = await runWithConcurrency(filterTasks, concurrencyLimit);

      // Filter out non-relevant results
      const relevantFiles = filterResults.filter((r): r is NonNullable<typeof r> => r !== null);
      
      onUpdate?.({ 
        content: [{ 
          type: "text", 
          text: `✅ ${relevantFiles.length}/${filesToFilter.length} files deemed relevant. Summarizing...` 
        }] 
      });

      if (relevantFiles.length === 0) {
        return {
          content: [{ 
            type: "text", 
            text: `No files found relevant to "${params.query}" after GLM filtering.\n\nEmbedding matches were found but none contained actually relevant content.` 
          }],
          details: { 
            query: params.query, 
            embeddingMatches: embeddingResults.length,
            relevantFiles: [] 
          }
        };
      }

      // Step 3: Summarize with GLM
      const summaryFiles = [...relevantFiles]
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SUMMARY_FILES);

      const summaryContext = summaryFiles
        .map((r, i) => {
          const content = r.relevantContent.length > MAX_SUMMARY_CHARS_PER_FILE
            ? `${r.relevantContent.substring(0, MAX_SUMMARY_CHARS_PER_FILE)}...`
            : r.relevantContent;
          return `## File ${i + 1}: ${r.path}\n\n${content}`;
        })
        .join('\n\n---\n\n');

      const summaryPrompt = `You are summarizing code search results for a developer.

QUERY: "${params.query}"

RELEVANT FILES:
${summaryContext}

TASK: Provide a clear, actionable summary of what was found:
1. Direct answer to the query if possible
2. Key files and their relevance
3. Code patterns or examples found
4. Any important observations

Be concise but comprehensive. Use markdown formatting.`;

      onUpdate?.({ 
        content: [{ 
          type: "text", 
          text: `📝 Generating summary with ${summaryModel}...` 
        }] 
      });

      let summary: string;
      try {
        summary = await callLLM(summaryPrompt, ctx.cwd, signal);
      } catch (error) {
        // Fallback to raw results on summary error
        summary = `Summary generation failed. Here are the relevant files:\n\n${
          relevantFiles.map(r => `**${r.path}** (${(r.score * 100).toFixed(1)}% match)\n${r.relevantContent.substring(0, 200)}...`).join('\n\n')
        }`;
      }

      // Build final result with relevant files list
      const sortedFiles = relevantFiles.sort((a, b) => b.score - a.score);
      const filesList = sortedFiles
        .map(r => `- ${r.path} (${(r.score * 100).toFixed(1)}% match)`)
        .join('\n');
      
      let resultText = `🎯 Semantic search results for: "${params.query}"\n\n`;
      resultText += `📊 Pipeline: ${embeddingResults.length} embeddings → ${filesToFilter.length} filtered → ${relevantFiles.length} relevant\n\n`;
      resultText += summary;
      resultText += `\n\n---\n\n**📁 Relevant files to read:**\n${filesList}`;

      return {
        content: [{ 
          type: "text", 
          text: resultText
        }],
        details: {
          query: params.query,
          embeddingMatches: embeddingResults.length,
          filesFiltered: filesToFilter.length,
          relevantFiles: sortedFiles.map(r => ({ path: r.path, score: r.score })),
          filterModel,
          summaryModel,
          indexUpdate: updateResult
        }
      };
    },

    renderCall(args, theme) {
      const queryPreview = args.query.length > 40 ? 
        args.query.substring(0, 40) + "..." : 
        args.query;
      
      let text = theme.fg("toolTitle", "🔍 semantic_search ") + 
                 theme.fg("accent", `"${queryPreview}"`);
      
      if (args.processWith) {
        text += theme.fg("muted", ` → ${args.processWith}`);
      }
      
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      if (result.isError) {
        return new Text(theme.fg("error", "✗ Search failed"), 0, 0);
      }

      const details = result.details as any;
      if (!details) {
        return new Text(theme.fg("success", "✓ Search finished"), 0, 0);
      }

      const fileCount = Array.isArray(details.relevantFiles) 
        ? details.relevantFiles.length 
        : details.relevantFiles || 0;
      
      let text = theme.fg("success", "✓ Found ") + 
                 theme.fg("dim", `${fileCount} relevant files`);
      
      return new Text(text, 0, 0);
    },
  });
  }

  // Register /semantic command for interactive interface
  if (ENABLE_LEGACY_TOOLS) {
  pi.registerCommand("semantic", {
    description: "Interactive semantic search interface",
    handler: async (_args, ctx) => {
      if (!await initializeOpenAI(ctx)) {
        ctx.ui.notify("OpenAI API key not found", "error");
        return;
      }

      // Check if index exists
      if (!indexExists(ctx.cwd)) {
        const selectedIndex = await ctx.ui.select(
          "No semantic index found. What would you like to do?",
          [
            { value: "create", label: "Create new index", description: "Build semantic index for this directory" },
            { value: "cancel", label: "Cancel", description: "Exit without creating index" }
          ]
        );

        if (selectedIndex === "create") {
          ctx.ui.setEditorText("Use semantic_index tool to create the index first");
        }
        return;
      }
      
      const existingMeta = loadIndexMetadata(ctx.cwd);
      if (!existingMeta) return;

      // Show interactive search interface
      await showSearchInterface(ctx, existingMeta);
    },
  });
  }

  // Register shortcut for quick search
  if (ENABLE_LEGACY_TOOLS) {
  pi.registerShortcut("ctrl+shift+s", {
    description: "Quick semantic search",
    handler: async (ctx) => {
      const query = await ctx.ui.input("Search query:");
      if (!query) return;
      
      ctx.ui.setEditorText(`semantic_search(query: "${query}")`);
    },
  });
  }

  // Helper functions
  function selectDiverseFiles(results: SearchResult[], maxCount: number): SearchResult[] {
    const selected: SearchResult[] = [];
    const seenDirs = new Set<string>();
    
    for (const result of results) {
      if (selected.length >= maxCount) break;
      
      const dir = path.dirname(result.chunk.path);
      if (!seenDirs.has(dir)) {
        selected.push(result);
        seenDirs.add(dir);
      }
    }
    
    // If we still have room, add more from seen dirs
    if (selected.length < maxCount) {
      for (const result of results) {
        if (selected.length >= maxCount) break;
        if (!selected.includes(result)) {
          selected.push(result);
        }
      }
    }
    
    return selected;
  }

  function createProcessingPrompt(
    query: string,
    results: SearchResult[],
    focus: string[],
    outputFormat: string
  ): string {
    const context = results.map((r, i) => 
      `File ${i + 1}: ${r.chunk.path} (lines ${r.chunk.startLine}-${r.chunk.endLine})\n` +
      `Relevance: ${(r.score * 100).toFixed(1)}%\n\n${r.chunk.content}`
    ).join('\n---\n\n');

    const focusText = focus.length > 0 ? 
      `\nFocus areas: ${focus.join(', ')}` : '';

    const outputInstructions = {
      summary: "Provide a concise summary of the key findings",
      detailed: "Provide a detailed analysis with specific examples",
      examples: "Extract and explain code examples and patterns",
      analysis: "Analyze the implementation, identify patterns, and note any issues"
    };

    return `You are analyzing code search results for the query: "${query}"${focusText}

SEARCH RESULTS:
${context}

TASK: ${outputInstructions[outputFormat as keyof typeof outputInstructions]}

Return only the processed analysis, no explanations about your process.`;
  }

  function formatSearchResults(results: SearchResult[]): string {
    const lines = [`${results.length} semantic matches found:\n`];
    
    for (let i = 0; i < Math.min(results.length, 10); i++) {
      const result = results[i];
      const relativePath = path.relative(process.cwd(), result.chunk.path);
      lines.push(
        `${i + 1}. ${relativePath}:${result.chunk.startLine}-${result.chunk.endLine} ` +
        `(${(result.score * 100).toFixed(1)}% match)`
      );
      lines.push(`   ${result.excerpt}`);
      lines.push('');
    }
    
    if (results.length > 10) {
      lines.push(`... and ${results.length - 10} more matches`);
    }
    
    return lines.join('\n');
  }

  async function showSearchInterface(ctx: ExtensionContext, indexMeta: IndexMetadata) {
    await ctx.ui.custom((tui, theme, done) => {
      let selectedOption = 0;
      let searchQuery = '';
      let searchBox = false;
      
      const options = [
        { value: 'search', label: '🔍 Search', description: 'Search the codebase semantically' },
        { value: 'recent', label: '📜 Recent searches', description: searchHistory.length > 0 ? `${searchHistory.length} recent` : 'No recent searches' },
        { value: 'stats', label: '📊 Index stats', description: `${indexMeta.fileCount} files indexed` },
        { value: 'done', label: '✅ Done', description: 'Exit search interface' }
      ];

      function render(): string[] {
        const container = new Container();
        
        // Header
        container.addChild(new Text(theme.fg("accent", theme.bold("Semantic Search Interface")), 1, 0));
        container.addChild(new Text(
          theme.fg("dim", `Index: ${indexMeta.chunkCount} chunks from ${indexMeta.fileCount} files`), 
          1, 0
        ));
        container.addChild(new Spacer(1));
        
        if (searchBox) {
          // Search input view
          container.addChild(new Text(theme.fg("accent", "Enter search query:"), 1, 0));
          container.addChild(new Text(`${theme.fg("muted", ">")} ${theme.fg("text", searchQuery || "_")}`, 1, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(
            theme.fg("dim", "↑↓ navigate • enter search • esc cancel"), 
            1, 0
          ));
        } else {
          // Menu view
          container.addChild(new Text(theme.fg("accent", "What would you like to do?"), 1, 0));
          container.addChild(new Spacer(1));
          
          for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const prefix = i === selectedOption ? "▶ " : "  ";
            const label = i === selectedOption ? 
              theme.fg("accent", opt.label) : 
              theme.fg("text", opt.label);
            container.addChild(new Text(`${prefix}${label} ${theme.fg("dim", opt.description)}`, 1, 0));
          }
          
          container.addChild(new Spacer(1));
          container.addChild(new Text(
            theme.fg("dim", "↑↓ navigate • enter select • esc exit"), 
            1, 0
          ));
        }
        
        
        return container.render(tui.getWidth());
      }

      function handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
          if (searchBox) {
            searchBox = false;
            searchQuery = '';
          } else {
            done();
          }
        } else if (searchBox) {
          // Handle search input
          if (matchesKey(data, Key.enter) && searchQuery.trim()) {
            // Trigger search
            ctx.ui.setEditorText(`semantic_search(query: "${searchQuery.trim()}")`);
            done();
          } else if (matchesKey(data, Key.backspace)) {
            searchQuery = searchQuery.slice(0, -1);
          } else if (data.length === 1 && searchQuery.length < 100) {
            searchQuery += data;
          }
        } else {
          // Handle menu navigation
          if (matchesKey(data, Key.up)) {
            selectedOption = (selectedOption - 1 + options.length) % options.length;
          } else if (matchesKey(data, Key.down)) {
            selectedOption = (selectedOption + 1) % options.length;
          } else if (matchesKey(data, Key.enter)) {
            const option = options[selectedOption].value;
            
            switch (option) {
              case 'search':
                searchBox = true;
                break;
              case 'recent':
                if (searchHistory.length > 0) {
                  showRecentSearches(ctx);
                }
                break;
              case 'stats':
                showIndexStats(ctx, indexMeta);
                break;
              case 'done':
                done();
                break;
            }
          }
        }
        
        tui.requestRender();
      }

      return {
        render,
        invalidate: () => {},
        handleInput
      };
    });
  }

  async function showRecentSearches(ctx: ExtensionContext) {
    if (searchHistory.length === 0) return;
    
    const selectedIndex = await ctx.ui.select(
      "Recent searches:",
      searchHistory.map(query => ({
        value: query,
        label: query,
        description: "Search again with this query"
      }))
    );
    
    if (selectedIndex) {
      ctx.ui.setEditorText(`semantic_search(query: "${selectedIndex}")`);
    }
  }

  function showIndexStats(ctx: ExtensionContext, metadata: IndexMetadata) {
    ctx.ui.notify(
      `Index stats: ${metadata.fileCount} files, ${metadata.chunkCount} chunks, created ${new Date(metadata.createdAt).toLocaleDateString()}`,
      "info"
    );
  }

  if (IS_SUBAGENT) {
    pi.setActiveTools(["read", "local_embedding_search"]);
  }

  }