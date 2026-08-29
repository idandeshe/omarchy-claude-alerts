import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./config.ts";
import type { Alert, WaitingEntry } from "./types.ts";

/**
 * Live "who is waiting on you" state, written where the Omarchy shell can
 * watch it. The bar widget file-watches this and renders it; the same pattern
 * the stock omarchy.agents plugin uses for its usage records.
 *
 * A sound is transient — if you are away from the desk you miss it entirely.
 * This file is the durable half: it keeps naming the waiting agents until you
 * actually deal with them.
 */
const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "omarchy",
  "claude-alerts",
);
const STATE_FILE = path.join(STATE_DIR, "state.json");

/** project -> entry. One waiting agent per project; a newer alert replaces it. */
const waiting = new Map<string, WaitingEntry>();

function write(): void {
  const payload = {
    updatedAt: new Date().toISOString(),
    waiting: [...waiting.values()].sort((a, b) => a.since.localeCompare(b.since)),
  };

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Write-then-rename: the widget must never observe a half-written file.
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    log(`state: could not write ${STATE_FILE}: ${(err as Error).message}`);
  }
}

/** An agent is now blocked on the human. */
export function markWaiting(alert: Alert): void {
  waiting.set(alert.project, {
    project: alert.project,
    event: alert.event,
    title: alert.title,
    message: alert.message,
    level: alert.level,
    since: new Date().toISOString(),
    sessionId: alert.sessionId,
  });
  write();
}

/** The agent moved on by itself, or you dealt with it. */
export function clearWaiting(project?: string): number {
  const removed = project ? (waiting.delete(project) ? 1 : 0) : waiting.size;
  if (!project) waiting.clear();
  if (removed) write();
  return removed;
}

export function snapshot(): WaitingEntry[] {
  return [...waiting.values()];
}

export const statePaths = { STATE_DIR, STATE_FILE };

/**
 * Restore the waiting list from disk on start.
 *
 * The service restarts whenever the shell does (and on every plugin reload),
 * but an agent that was blocked on you before that is *still* blocked on you —
 * dropping it would lose the very thing this exists to tell you. Entries older
 * than maxAgeMs are discarded instead: past that, the far likelier story is
 * that the agent moved on while nothing was listening.
 */
export function initState(maxAgeMs = 12 * 60 * 60 * 1000): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const cutoff = Date.now() - maxAgeMs;
    let restored = 0;
    let dropped = 0;

    for (const entry of parsed?.waiting ?? []) {
      if (!entry?.project || !entry?.since) continue;
      const at = Date.parse(entry.since);
      if (isNaN(at) || at < cutoff) { dropped++; continue; }
      waiting.set(entry.project, entry as WaitingEntry);
      restored++;
    }
    if (restored || dropped) log(`state: restored ${restored} waiting, dropped ${dropped} stale`);
  } catch {
    // No file, or an unreadable one: an empty list is the right start.
  }
  write();
}
