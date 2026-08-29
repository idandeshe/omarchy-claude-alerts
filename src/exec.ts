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
