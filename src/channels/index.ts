import type { Channel } from "../types.ts";
import { notifyChannel } from "./notify.ts";
import { soundChannel } from "./sound.ts";

/**
 * The extension point. To add an alert kind later — hyprctl window focus,
 * ntfy phone push — write one module exporting a Channel and register it
 * here. Nothing else in the service changes; reference it by name from a
 * rule's "channels" list in config.json.
 */
export const channels = new Map<string, Channel>(
  [soundChannel, notifyChannel].map((c) => [c.name, c]),
);
