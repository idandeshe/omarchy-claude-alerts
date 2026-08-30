import { randomUUID } from "node:crypto";
import path from "node:path";
import { channels } from "./channels/index.ts";
import { config, log } from "./config.ts";
import { clearWaiting, markWaiting } from "./state.ts";
import type { AlertRequest, HookPayload, Level, Resolved, Rule } from "./types.ts";

const MAX_MESSAGE = 200;

/** Why an alert did or didn't reach the channels. */
export type DispatchStatus = "sent" | "duplicate" | "debounced" | "ignored";

/** group key -> last dispatch time. Collapses overlapping events. */
const lastFired = new Map<string, number>();
/** uuid -> first seen time. Exact idempotency. */
const seenUuids = new Map<string, number>();

type ResolvedRule = {
  channels: string[];
  sound: string;
  level: Level;
  title: string;
  group: string;
  ignore: boolean;
  state: "waiting" | "clear" | "none";
};

/** Groups carry an obvious default, so most rules never set `state` at all. */
function defaultState(group: string): "waiting" | "clear" | "none" {
  if (group === "attention") return "waiting";
  if (group === "done") return "clear";
  return "none";
}

/**
 * Rules resolve most-specific first: "Notification:permission_prompt" beats
 * "Notification" beats defaultRule. That is what lets one Notification hook
 * cover every attention case with its own sound and wording, instead of
 * wiring the overlapping top-level events separately.
 */
function resolveRule(event: string, notificationType?: string): ResolvedRule {
  const { defaultRule, rules } = config();
  const generic: Rule = rules[event] ?? {};
  const specific: Rule = (notificationType && rules[`${event}:${notificationType}`]) || {};
  const merged: Rule = { ...generic, ...specific };
  // Ungrouped events debounce against themselves.
  const group = merged.group ?? (notificationType ? `${event}:${notificationType}` : event);

  return {
    channels: merged.channels ?? defaultRule.channels,
    sound: merged.sound ?? defaultRule.sound,
    level: merged.level ?? defaultRule.level,
    title: merged.title ?? defaultRule.title,
    group,
    ignore: merged.ignore ?? false,
    state: merged.state ?? defaultState(group),
  };
}

/** One line, trimmed to something a notification bubble can actually show. */
function tidy(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_MESSAGE ? `${flat.slice(0, MAX_MESSAGE - 1)}…` : flat;
}

export function fromHook(p: HookPayload): Resolved {
  const event = p.hook_event_name || "Unknown";
  const rule = resolveRule(event, p.notification_type);

  // Notification carries `message`; Stop/SubagentStop carry the final reply.
  const body = p.message || p.last_assistant_message || "";

  return {
    alert: {
      uuid: p.uuid || randomUUID(),
      event: p.notification_type ? `${event}:${p.notification_type}` : event,
      project: p.cwd ? path.basename(p.cwd) : "claude",
      title: rule.title,
      message: tidy(body) || event,
      level: rule.level,
      sound: rule.sound,
      group: rule.group,
      sessionId: p.session_id,
    },
    channels: rule.channels,
    ignored: rule.ignore,
    state: rule.state,
  };
}

export function fromRequest(r: AlertRequest): Resolved {
  const event = r.event || "Custom";
  const rule = resolveRule(event);

  return {
    alert: {
      uuid: r.uuid || randomUUID(),
      event,
      project: r.project || "claude",
      title: r.title || rule.title,
      message: tidy(r.message || "") || event,
      level: (r.level as Level) || rule.level,
      sound: r.sound || rule.sound,
      group: r.group ?? rule.group,
    },
    channels: r.channels ?? rule.channels,
    ignored: rule.ignore,
    state: rule.state,
  };
}

/**
 * Fan out to channels. Never throws and never awaited by the request handler:
 * a hook call sits on the agent's critical path, so it gets its 200 back
 * before any of this runs.
 *
 * Two layers of suppression, in order:
 *   1. uuid    — exact. A repeat of the same trigger is ignored outright.
 *   2. group   — time-windowed. Distinct events describing one real-world
 *                moment (a permission dialog fires Notification *and*
 *                PermissionRequest) collapse into a single alert.
 */
export function dispatch(resolved: Resolved): DispatchStatus {
  const { alert, channels: names, ignored, state } = resolved;
  const now = Date.now();

  if (ignored) {
    log(`ignored ${alert.project}|${alert.event} (rule)`);
    return "ignored";
  }

  // A clear is applied before any suppression runs. Answering a question lands
  // moments after the event that raised the alert, which is exactly when a
  // same-group debounce would swallow it — and a swallowed clear leaves the
  // badge lit with nothing left to put it out. Clearing is idempotent and
  // costs nothing, so suppression has nothing to protect here.
  if (state === "clear") {
    const removed = clearWaiting(alert.project);
    // The clearing events fire on every tool batch; a line per no-op would
    // bury everything else in the journal.
    if (removed) log(`resolved ${alert.project} (${alert.event})`);
  }

  // Silent state-only events stop here. They announce nothing, so there is no
  // reason to spend uuid or debounce bookkeeping on them — and without this,
  // every idle tool batch logs a debounce line for a group nobody alerts on.
  // Events that do announce (Stop clears *and* chimes) carry on below.
  if (names.length === 0 && state !== "waiting") return "sent";

  const firstSeen = seenUuids.get(alert.uuid);
  if (firstSeen !== undefined && now - firstSeen < config().uuidTtlMs) {
    log(`duplicate uuid ${alert.uuid} for ${alert.project}|${alert.event}, ignored`);
    return "duplicate";
  }
  seenUuids.set(alert.uuid, now);

  const groupKey = `${alert.project}|${alert.group}`;
  const previous = lastFired.get(groupKey);
  if (previous !== undefined && now - previous < config().debounceMs) {
    log(`debounced ${groupKey} (${alert.event})`);
    return "debounced";
  }
  lastFired.set(groupKey, now);

  if (lastFired.size > 500 || seenUuids.size > 2000) prune(now);

  // Deliberately after the debounce: a debounced repeat must not refresh
  // `since`, or "waited 4m" would keep resetting to zero.
  if (state === "waiting") markWaiting(alert);

  // Silent rules carry no channels — a state change with nothing to announce.
  if (names.length === 0) return "sent";

  log(
    `alert ${alert.project}|${alert.event} group=${alert.group} ` +
      `level=${alert.level} sound=${alert.sound} uuid=${alert.uuid} -> [${names.join(", ")}]`,
  );

  for (const name of names) {
    const channel = channels.get(name);
    if (!channel) {
      log(`unknown channel "${name}"`);
      continue;
    }
    // One failing channel must not suppress the others.
    channel.send(alert).catch((err) => log(`channel ${name} failed: ${err.message}`));
  }
  return "sent";
}

function prune(now: number): void {
  const { debounceMs, uuidTtlMs } = config();
  for (const [key, at] of lastFired) {
    if (now - at > debounceMs * 10) lastFired.delete(key);
  }
  for (const [uuid, at] of seenUuids) {
    if (now - at > uuidTtlMs) seenUuids.delete(uuid);
  }
}
