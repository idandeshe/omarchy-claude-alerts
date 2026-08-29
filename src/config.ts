import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./types.ts";

const CONFIG_DIR = path.join(os.homedir(), ".config", "claude-alerts");
const USER_CONFIG = path.join(CONFIG_DIR, "config.json");
const TOKEN_FILE = path.join(CONFIG_DIR, "token");
const BUNDLED_CONFIG = new URL("../config.json", import.meta.url);

// Declared before the first readConfig() call: its error path reads `current`.
let current: Config | undefined;

function readJson(file: string | URL): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Bundled config.json is the baseline; ~/.config/claude-alerts/config.json
 * overrides it. Rules merge per-event so a user file can retune one sound
 * without restating the whole table.
 */
function readConfig(): Config {
  const base = readJson(BUNDLED_CONFIG) as Config;
  if (!fs.existsSync(USER_CONFIG)) return base;

  try {
    const user = readJson(USER_CONFIG) as Partial<Config>;
    return {
      ...base,
      ...user,
      defaultRule: { ...base.defaultRule, ...user.defaultRule },
      rules: { ...base.rules, ...user.rules },
    };
  } catch (err) {
    log(`bad ${USER_CONFIG}, keeping previous config: ${(err as Error).message}`);
    return current ?? base;
  }
}

current = readConfig();

export function config(): Config {
  return current as Config;
}

/** Reload on edits to the user config, so retuning sounds needs no restart. */
export function watchConfig(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  let timer: NodeJS.Timeout | undefined;
  try {
    fs.watch(CONFIG_DIR, (_event, filename) => {
      if (filename !== "config.json") return;
      clearTimeout(timer);
      // Editors write in bursts; settle before re-reading.
      timer = setTimeout(() => {
        current = readConfig();
        log("config reloaded");
      }, 250);
    });
  } catch (err) {
    log(`config watch unavailable: ${(err as Error).message}`);
  }
}

/** Shared secret, generated on first run. Readable only by you. */
export function token(): string {
  if (fs.existsSync(TOKEN_FILE)) {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  }

  const generated = randomBytes(24).toString("hex");
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, `${generated}\n`, { mode: 0o600 });
  log(`generated a new token at ${TOKEN_FILE}`);
  return generated;
}

export const paths = { CONFIG_DIR, USER_CONFIG, TOKEN_FILE };

export function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
