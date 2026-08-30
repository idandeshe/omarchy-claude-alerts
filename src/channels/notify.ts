import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../config.ts";
import { run, runCapture } from "../exec.ts";
import type { Alert, Channel } from "../types.ts";

const URGENCY = { low: "low", normal: "normal", critical: "critical" } as const;

// Absolute, because the shell runs the click argv detached, with no shell
// interpretation and not our PATH.
const CTL = path.resolve(fileURLToPath(new URL("../../bin/claude-alerts-ctl", import.meta.url)));

/** project -> the id of the toast currently on screen for it. */
const shown = new Map<string, number>();

/**
 * Escape the three markup-significant characters before a title or message
 * leaves for the notification daemon.
 *
 * The body of a toast is the agent's own prose, arriving over the HTTP API. The
 * freedesktop spec says a daemon advertising `body-markup` renders the body as
 * markup, and Omarchy's does — an unescaped `<b>` there comes out bold with the
 * tags eaten, which is at best a mangled message and at worst markup we never
 * intended, rendered inside the long-lived shell process. Escaping is what a
 * markup-aware daemon expects; a daemon that ignores markup shows the entities
 * literally, which is the lesser of the two failures.
 */
function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Omarchy's own sender, when present, makes the toast clickable.
 *
 * Its --exec is stored as an `omarchy-exec-argv` hint that the shell runs
 * detached on body click, and persistence preserves it — so the toast stays
 * clickable after this process is long gone. A plain libnotify "default"
 * action cannot do that: the shell only invokes it while the sender is still
 * live (see the shell's plugins/notifications/Service.qml).
 */
let omarchySender: string | null | undefined;

function findOmarchySender(): string | null {
  if (omarchySender !== undefined) return omarchySender;

  const candidates = ["/usr/share/omarchy/bin/omarchy-notification-send"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "omarchy-notification-send"));
  }

  omarchySender = candidates.find((c) => existsSync(c)) ?? null;
  log(
    omarchySender
      ? `notify: clickable toasts via ${omarchySender}`
      : "notify: omarchy-notification-send not found, falling back to notify-send (toasts won't be clickable)",
  );
  return omarchySender;
}

async function sendClickable(sender: string, alert: Alert): Promise<boolean> {
  const previous = shown.get(alert.project);

  const args = [
    "--app-name", "Claude Code",
    "-u", URGENCY[alert.level],
    "-p", // print the id, so the next alert for this project can replace it
    ...(previous !== undefined ? ["-r", String(previous)] : []),
    escapeMarkup(`${alert.project} — ${alert.title}`),
    escapeMarkup(alert.message),
    // "focus" and the project stay separate argv entries: the sender rejects a
    // single --exec argument containing whitespace.
    "--exec", CTL, "focus", alert.project,
  ];

  const { code, stdout } = await runCapture(sender, args, 5_000);
  if (code !== 0) return false;

  const id = Number.parseInt(stdout.trim(), 10);
  if (Number.isFinite(id)) shown.set(alert.project, id);
  return true;
}

async function sendPlain(alert: Alert): Promise<void> {
  const code = await run("notify-send", [
    "-a", "Claude Code",
    "-u", URGENCY[alert.level],
    // Tag per project so repeat alerts from one agent replace each other
    // instead of stacking into a wall of notifications.
    "-h", `string:x-canonical-private-synchronous:claude-${alert.project}`,
    escapeMarkup(`${alert.project} — ${alert.title}`),
    escapeMarkup(alert.message),
  ], 5_000);

  if (code !== 0) log(`notify: notify-send exited ${code}`);
}

export const notifyChannel: Channel = {
  name: "notify",
  async send(alert: Alert) {
    const sender = findOmarchySender();
    // Fall through to notify-send if the Omarchy path fails for any reason:
    // a missing toast is worse than a toast you cannot click.
    if (sender && (await sendClickable(sender, alert))) return;
    await sendPlain(alert);
  },
};

/** Forget a project's toast id once it is no longer waiting. */
export function forgetNotification(project: string): void {
  shown.delete(project);
}
