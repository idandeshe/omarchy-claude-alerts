import { config, log } from "../config.ts";
import { run } from "../exec.ts";
import type { Alert, Channel } from "../types.ts";

const THEME_DIR = "/usr/share/sounds/freedesktop/stereo";

// Serialized playback: with several agents firing at once, overlapping chimes
// are an unreadable mush. One at a time, and drop the overflow — a stale
// chime three seconds late tells you nothing.
const queue: string[] = [];
let draining = false;

async function play(name: string): Promise<void> {
  // canberra resolves the freedesktop theme by name and respects the user's
  // sound theme; paplay on the raw .oga is the fallback.
  if ((await run("canberra-gtk-play", ["-i", name])) === 0) return;
  if ((await run("paplay", [`${THEME_DIR}/${name}.oga`])) === 0) return;
  log(`sound: could not play "${name}"`);
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) await play(queue.shift() as string);
  } finally {
    draining = false;
  }
}

export const soundChannel: Channel = {
  name: "sound",
  async send(alert: Alert) {
    if (queue.length >= config().soundQueueMax) {
      log(`sound: queue full, dropping "${alert.sound}" for ${alert.project}`);
      return;
    }
    queue.push(alert.sound);
    // Deliberately not awaited: the caller is on the agent's critical path.
    void drain();
  },
};
