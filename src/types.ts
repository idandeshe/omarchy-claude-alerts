export type Level = "low" | "normal" | "critical";

/** A fully resolved alert, ready to hand to any channel. */
export type Alert = {
  /**
   * Idempotency key. Supplied by the caller to make a trigger repeatable
   * without re-alerting (retries, at-least-once senders, two code paths
   * reporting one event); generated per-alert when absent, which never
   * collides and so never suppresses anything.
   */
  uuid: string;
  event: string;
  /** basename(cwd) — how you recognise which agent is calling. */
  project: string;
  title: string;
  message: string;
  level: Level;
  /** freedesktop sound name, e.g. "window-attention". */
  sound: string;
  /** Debounce bucket; see Rule.group. */
  group: string;
  sessionId?: string;
};

/** How one event should be alerted. All fields fall back to defaultRule. */
export type Rule = {
  channels?: string[];
  sound?: string;
  level?: Level;
  title?: string;
  /**
   * Debounce bucket. Claude Code fires overlapping events for one real-world
   * moment — a permission dialog raises both Notification(permission_prompt)
   * and PermissionRequest. Rules sharing a group collapse into one alert.
   * Defaults to the event name, so ungrouped events debounce on themselves.
   */
  group?: string;
  /** Never alert on this. For the purely informational notification types. */
  ignore?: boolean;
  /**
   * What this event does to the bar widget's waiting list.
   *   "waiting" — the agent is blocked on you; show it until dealt with
   *   "clear"   — the agent moved on; drop it from the list
   *   "none"    — alert only, leave the list alone
   * Defaults from `group`: attention -> waiting, done -> clear, else none.
   */
  state?: "waiting" | "clear" | "none";
};

/** One agent currently blocked on the human, as the bar widget sees it. */
export type WaitingEntry = {
  project: string;
  event: string;
  title: string;
  message: string;
  level: Level;
  /** ISO timestamp, so the panel can render "waited 2m". */
  since: string;
  sessionId?: string;
};

export type Config = {
  port: number;
  bind: string[];
  debounceMs: number;
  /** How long a seen uuid keeps suppressing repeats. */
  uuidTtlMs: number;
  soundQueueMax: number;
  defaultRule: Required<Pick<Rule, "channels" | "sound" | "level" | "title">>;
  rules: Record<string, Rule>;
};

/**
 * The extension point. A new alert kind (window focus, phone push) is one
 * module exporting this, plus one line in channels/index.ts.
 */
export type Channel = {
  name: string;
  send(alert: Alert): Promise<void>;
};

/** Fields Claude Code sends on the hook payload that we care about. */
export type HookPayload = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  last_assistant_message?: string;
  /** Notification's sub-type: permission_prompt, idle_prompt, agent_needs_input, … */
  notification_type?: string;
  agent_type?: string;
  /** Honoured as an idempotency key if a sender ever supplies one. */
  uuid?: string;
};

/** Body accepted by POST /alert, for scripts and CI. */
export type AlertRequest = {
  event?: string;
  project?: string;
  title?: string;
  message?: string;
  level?: Level;
  sound?: string;
  channels?: string[];
  group?: string;
  /** Idempotency key: a repeat with the same uuid is ignored. */
  uuid?: string;
};

/** Outcome of turning a request into an alert. */
export type Resolved = {
  alert: Alert;
  channels: string[];
  ignored: boolean;
  state: "waiting" | "clear" | "none";
};
