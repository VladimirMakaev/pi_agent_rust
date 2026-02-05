import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  signal?: AbortSignal,
  stdin?: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          child.kill("SIGTERM");
          reject(new Error("Command aborted"));
        },
        { once: true },
      );
    }

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error(`Command not found: ${command}`));
      } else {
        reject(err);
      }
    });
  });
}
