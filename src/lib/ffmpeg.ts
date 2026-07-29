import { spawn } from "node:child_process";

export async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new Error("Cancelled."));
      return;
    }

    const child = spawn(command, args, {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => {
      child.kill("SIGKILL");
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener("abort", onAbort);
      if (options?.signal?.aborted) {
        reject(new Error("Cancelled."));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} exited with code ${code}\n${stderr.slice(-4000)}`,
        ),
      );
    });
  });
}

export async function ensureFfmpegTools(): Promise<void> {
  await runCommand("ffmpeg", ["-version"]);
  await runCommand("ffprobe", ["-version"]);
}
