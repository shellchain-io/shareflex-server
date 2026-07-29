import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const HOMEBREW_BIN = "/opt/homebrew/bin";
const USR_LOCAL_BIN = "/usr/local/bin";

function pathWithBrew(): string {
  const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const extra of [HOMEBREW_BIN, USR_LOCAL_BIN]) {
    if (!parts.includes(extra)) {
      parts.unshift(extra);
    }
  }
  return parts.join(path.delimiter);
}

function resolveBinary(name: "ffmpeg" | "ffprobe"): string {
  const envKey = name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  for (const dir of [HOMEBREW_BIN, USR_LOCAL_BIN]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return name;
}

/** True when ffmpeg binary resolves to an existing path or will be found on PATH. */
export function ffmpegBinaryPath(): string {
  return resolveBinary("ffmpeg");
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await runCommand("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  const resolved =
    command === "ffmpeg" || command === "ffprobe"
      ? resolveBinary(command)
      : command;

  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new Error("Cancelled."));
      return;
    }

    const child = spawn(resolved, args, {
      cwd: options?.cwd,
      env: { ...process.env, PATH: pathWithBrew() },
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
      const hint =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? ` (looked for ${resolved}; install ffmpeg or set FFMPEG_PATH)`
          : "";
      reject(new Error(`${error.message}${hint}`));
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
          `${resolved} exited with code ${code}\n${stderr.slice(-4000)}`,
        ),
      );
    });
  });
}

export async function ensureFfmpegTools(): Promise<void> {
  await runCommand("ffmpeg", ["-version"]);
  await runCommand("ffprobe", ["-version"]);
}
