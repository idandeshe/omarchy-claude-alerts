import { spawn } from "node:child_process";

/**
 * Run a command to completion, never throwing. Returns the exit code, or a
 * negative sentinel: -1 could not spawn, -2 killed on timeout.
 *
 * The timeout matters: a wedged audio player must not stall the sound queue.
 */
export function run(cmd: string, args: string[], timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore" });
    } catch {
      resolve(-1);
      return;
    }

    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-2);
    }, timeoutMs);

    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/**
 * Same contract as run(), but returns what the command printed. Used to read a
 * notification id back so the next alert for that project can replace it.
 */
export function runCapture(
  cmd: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve({ code: -1, stdout: "" });
      return;
    }

    let out = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-2);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}
