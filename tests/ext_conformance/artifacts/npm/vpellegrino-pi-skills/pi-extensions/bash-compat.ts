import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type BashParams = {
  command: string;
  workdir?: string;
  timeout?: number;
  description?: string;
};

type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string | null;
  timedOut: boolean;
};

const runCommand = (params: BashParams, signal?: AbortSignal): Promise<ExecResult> =>
  new Promise((resolve) => {
    const child = spawn(params.command, {
      shell: true,
      cwd: params.workdir,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutId: NodeJS.Timeout | undefined;

    if (params.timeout && params.timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, params.timeout);
    }

    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
      } else {
        signal.addEventListener(
          "abort",
          () => {
            child.kill("SIGTERM");
          },
          { once: true },
        );
      }
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (exitCode, exitSignal) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 0,
        signal: exitSignal,
        timedOut,
      });
    });
  });

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bash",
    label: "Bash (compat)",
    description: "Execute shell commands without streaming callbacks.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute." }),
      workdir: Type.Optional(Type.String({ description: "Working directory." })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds." })),
      description: Type.Optional(Type.String({ description: "Short task description." })),
    }),
    async execute(_toolCallId, params: BashParams, signal) {
      const result = await runCommand(params, signal);
      const text = [
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter((value) => value.length > 0)
        .join("\n");

      return {
        content: [{ type: "text", text: text || "(no output)" }],
        details: {
          exitCode: result.exitCode,
          signal: result.signal ?? null,
          timedOut: result.timedOut,
        },
      };
    },
  });
}
