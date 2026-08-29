# Claude Alerts

An Omarchy plugin that tells you when a Claude Code agent needs you — with a
sound, a desktop notification, and a bar badge naming **which** project is
waiting.

Built for running several agents at once in devcontainers, where the container
has no practical access to the host's sound system.

```
bar:  ◉ 2

panel:
  checkout-service — wants permission    2m
  Wants to run: npm test
  api-gateway — is waiting on you        18s
  Waiting for your reply
```

Click a row to focus that project's window and drop it from the list.

## Install

```bash
omarchy plugin add https://github.com/idandeshe/omarchy-claude-alerts.git --enable
```

Then allow containers through the firewall (once), and copy your token:

```bash
sudo ufw allow from 172.16.0.0/12 to any port 8787 proto tcp comment 'claude-alerts'
cat ~/.config/claude-alerts/token
```

**Requirements:** Node 22 or newer (`sudo pacman -S nodejs`), plus `curl` and
`jq`. Nothing is installed inside your containers.

### About the firewall step

Omarchy's ufw defaults to `DEFAULT_INPUT_POLICY="DROP"`, and container→host
traffic hits the INPUT chain. The `ufw-docker` rules in
`/etc/ufw/after.rules` only govern FORWARD, so they do **not** cover this —
without that rule, containers time out connecting to the host.

`172.16.0.0/12` spans every Docker bridge subnet and overlaps neither a typical
LAN (`192.168.x`) nor a VPN (`10.x`). Only containers on your machine can reach
the port. On firewalld: `sudo firewall-cmd --permanent --add-rich-rule='rule
family=ipv4 source address=172.16.0.0/12 port port=8787 protocol=tcp accept'`.

## Wiring a project

Paste into the project's `.claude/settings.local.json` — gitignored, so the
token stays out of git:

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [ {
          "type": "http",
          "url": "http://172.17.0.1:8787/hook",
          "timeout": 5,
          "headers": { "X-Alert-Token": "PASTE_TOKEN_HERE" }
      } ] }
    ],
    "StopFailure": [
      { "hooks": [ {
          "type": "http",
          "url": "http://172.17.0.1:8787/hook",
          "timeout": 5,
          "headers": { "X-Alert-Token": "PASTE_TOKEN_HERE" }
      } ] }
    ]
  }
}
```

Claude Code's native `"type": "http"` hook does the POST itself, which is why
nothing needs installing in the container. `172.17.0.1` is the docker0 gateway:
reachable from containers on any bridge network, not from your LAN.

To commit hooks to a repo instead, put them in `.claude/settings.json` with
`"headers": {"X-Alert-Token": "$CLAUDE_ALERT_TOKEN"}` and
`"allowedEnvVars": ["CLAUDE_ALERT_TOKEN"]`, then set that var via
`remoteEnv` in `devcontainer.json`. Interpolation only resolves names listed in
`allowedEnvVars`; omit it and the header silently comes through empty.

### Which events

**`Notification` is the umbrella event.** It fires for every case where Claude
is waiting on a human, tagged with a `notification_type`:

| `notification_type` | Meaning | Alert |
|---|---|---|
| `permission_prompt` | Wants permission to run something | `window-attention`, critical |
| `idle_prompt` | Idle, waiting on you | `window-question`, critical |
| `agent_needs_input` | Blocked needing input | `window-question`, critical |
| `elicitation_dialog` | An MCP server is asking you something | `window-question`, critical |
| `elicitation_url_dialog` | Needs you to open a URL | `window-question`, critical |
| `agent_completed` | An agent finished | `complete`, normal |
| `quota_auto_resume_stale` / `_disabled` | Quota resume needs you | `dialog-warning`, critical |
| `auth_success`, `elicitation_complete`, `elicitation_response` | Informational | **ignored** |

Wire `Notification` and every attention case is covered. Alongside it:

| Event | Fires when | Wire it? |
|---|---|---|
| `StopFailure` | The turn died on an API error | **Yes** — not covered by `Notification` |
| `TeammateIdle` | An agent-team teammate is going idle | **Yes** — only fires if you use teams |
| `Stop` | The agent finished its turn | Optional; also clears it from the bar |
| `PermissionRequest` | A permission decision is needed | **No** — documented duplicate of `Notification:permission_prompt`, *and* it blocks the agent |
| `Elicitation` | MCP server requesting input | **No** — duplicate of `Notification:elicitation_dialog`, and blocking |
| `TaskCompleted`, `SubagentStop` | Completion | Optional; `SubagentStop` is noisy if you fan out |

The blocking events sit on the agent's critical path and buy no extra signal.
Wire them anyway and they share a debounce `group` with their `Notification`
twin, so you still get one alert per real dialog.

## Why you don't get alert spam

Running many agents at once is the design centre, so suppression happens in
four layers:

1. **`uuid`** — exact. The same trigger sent twice alerts once.
2. **`group`** — time-windowed. Claude Code fires overlapping events for one
   real moment (a permission dialog raises `Notification` *and*
   `PermissionRequest`); rules sharing a group collapse into one alert.
3. **Playback** — sounds play one at a time through a capped queue, and
   notifications carry a per-project tag so one chatty agent replaces its own
   notification instead of stacking.
4. **The badge** — the durable half. A sound you miss while away is gone; the
   bar keeps naming who is waiting until you deal with them.

## Clicking the notification

Click the toast and you land on that project's VS Code window; the entry clears
itself at the same time. That is the fastest path from "something needs me" to
being there.

This uses `omarchy-notification-send --exec`, which stores the click command as
a hint the shell runs detached — so the toast stays clickable after the sender
has exited, and still works from notification history. A plain libnotify action
cannot do that: the shell only invokes it while the sender is alive.

Off Omarchy the toast still appears via `notify-send`, just without the click.

The window is found by slug-normalizing both the project name and the window
title before comparing, because the two are written differently — project
`checkout-service` against a title reading
`… checkout (Workspace) [Dev Container: Checkout Service] …`. If several windows
match, the most recently focused one wins.

## The bar widget

Shows a count of agents blocked on you, and takes no space at all when none
are. Click for the list; click a row to focus that project's window (matched on
the window title) and clear it.

An entry clears when you click it, when you press **Clear all**, or on its own
when the agent moves on — a `Stop` or `TaskCompleted` for that project.

The waiting list survives a shell restart: an agent that was blocked before is
still blocked. Entries older than 12 hours are dropped instead.

## Command line

`bin/claude-alerts-ctl` lives in the plugin folder. To use it by name, link it
once:

```bash
ln -s ~/.config/omarchy/plugins/idan.claude-alerts/bin/claude-alerts-ctl ~/.local/bin/
```

```bash
claude-alerts-ctl state             # what is waiting on you
claude-alerts-ctl focus <project>   # focus that window and clear it
claude-alerts-ctl clear [project]   # clear one, or all
claude-alerts-ctl health            # service liveness
claude-alerts-ctl test              # fire a test alert
```

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/hook` | Claude Code hook payload. Always answers `200 {}` |
| `POST` | `/alert` | Generic alert for scripts/CI |
| `POST` | `/clear` | Clear one project (`{"project":"x"}`) or all (`{}`) |
| `GET` | `/state` | The waiting list |
| `GET` | `/health` | Liveness. No auth on loopback |
| `POST` | `/test` | Fire a synthetic alert |

Auth is `X-Alert-Token: <token>` or `Authorization: Bearer <token>`.

`/alert` reports the outcome — `sent`, `duplicate`, `debounced` or `ignored`:

```json
{ "ok": true, "status": "sent", "uuid": "…", "project": "my-app", "event": "Stop" }
```

Pass a `uuid` to make a trigger idempotent; a repeat within `uuidTtlMs`
(default 60s) is ignored. Any string works. Omit it and one is generated, which
never collides and so never suppresses anything.

```bash
T=$(cat ~/.config/claude-alerts/token)
curl -s -X POST http://127.0.0.1:8787/alert -H "X-Alert-Token: $T" \
  -H 'Content-Type: application/json' \
  -d '{"event":"Stop","project":"my-app","message":"Deployed","uuid":"deploy-run-7"}'
```

Two properties `/hook` guarantees, because it sits on the agent's critical
path: it responds **before** dispatching, and returns `200` even on a malformed
body. A broken alert must never make an agent look broken.

## Configuration

`config.json` in the plugin folder is the baseline; drop a
`~/.config/claude-alerts/config.json` to override it. Rules merge per event, so
you can retune one sound without restating the table. Edits apply live.

```json
{
  "port": 8787,
  "bind": ["127.0.0.1", "172.17.0.1"],
  "debounceMs": 3000,
  "uuidTtlMs": 60000,
  "soundQueueMax": 5,
  "rules": {
    "Notification:idle_prompt": { "sound": "window-question", "level": "critical", "title": "is waiting on you", "group": "attention" },
    "Notification:auth_success": { "ignore": true }
  }
}
```

Rule keys resolve most-specific first: `Notification:idle_prompt` beats
`Notification` beats `defaultRule`.

- `sound` — any name from `/usr/share/sounds/freedesktop/stereo` (without `.oga`)
- `level` — `low` | `normal` | `critical`; maps to notification urgency
- `group` — debounce bucket; rules sharing one collapse into a single alert
- `state` — `waiting` | `clear` | `none`; what it does to the bar list
- `ignore` — never alert on this

## Adding an alert channel

`Channel` in `src/types.ts` is the extension point:

```ts
export type Channel = { name: string; send(alert: Alert): Promise<void> }
```

Write `src/channels/push.ts`, add it to the array in `src/channels/index.ts`,
then name it in a rule's `channels`. Nothing else changes.

## Running without Omarchy

The service is a plain Node program; the plugin only supervises it. On a
headless host, or one not running the Omarchy shell, use the unit in
`systemd/`:

```bash
cp systemd/claude-alerts.service ~/.config/systemd/user/
systemctl --user enable --now claude-alerts
```

Running both is harmless — whichever starts second finds the port taken and
exits.

## Troubleshooting

| Symptom | Check |
|---|---|
| Container times out | The ufw rule. `docker exec <c> curl -m5 http://172.17.0.1:8787/health` |
| No sound | `canberra-gtk-play -i window-attention` on the host |
| No notification | `notify-send test body` |
| Widget never appears | It hides when nothing is waiting. `claude-alerts-ctl state` |
| Only the first of several alerts | Working as intended — `debounceMs` |
| `401` | Token mismatch; re-copy `~/.config/claude-alerts/token` |
| Service not running | `journalctl --user -f \| grep claude-alerts`, or run `bin/claude-alerts-server` by hand |

## License

MIT
