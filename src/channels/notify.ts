import { log } from "../config.ts";
import { run } from "../exec.ts";
import type { Alert, Channel } from "../types.ts";

const URGENCY = { low: "low", normal: "normal", critical: "critical" } as const;

export const notifyChannel: Channel = {
  name: "notify",
  async send(alert: Alert) {
    const args = [
      "-a", "Claude Code",
      "-u", URGENCY[alert.level],
      // Tag per project so repeat alerts from one agent replace each other
      // instead of stacking into a wall of notifications.
      "-h", `string:x-canonical-private-synchronous:claude-${alert.project}`,
      `${alert.project} — ${alert.title}`,
      alert.message,
    ];

    const code = await run("notify-send", args, 5_000);
    if (code !== 0) log(`notify: notify-send exited ${code}`);
  },
};
