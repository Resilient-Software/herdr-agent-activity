// Installs / removes agent hooks and the sidebar layout. Every edit is
// idempotent, backed up once, identified by the shim path, and reversible.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const CLAUDE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
];
// Only tools that start, stop, or schedule background work.
export const CLAUDE_TOOL_MATCHER =
  "Bash|Monitor|Agent|Task|CronCreate|CronDelete|ScheduleWakeup|TaskStop|KillShell|KillBash";
export const CODEX_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop"];

const BLOCK_START = "# >>> herdr-agent-activity (managed: remove with the plugin's uninstall action) >>>";
const BLOCK_END = "# <<< herdr-agent-activity <<<";

function summaryToken() {
  return (
    '{ token = "$rsact_summary", fg = "#89b4fa", rules = [' +
    '{ contains = "subagent", fg = "#f9e2af" }, ' +
    '{ contains = "bg", fg = "#89b4fa" }, ' +
    '{ contains = "monitor", fg = "#89b4fa" }, ' +
    '{ starts_with = "loop", fg = "#cba6f7" }, ' +
    '{ starts_with = "next", fg = "#cba6f7" }] }'
  );
}

export function sidebarBlock() {
  const token = summaryToken();
  return [
    BLOCK_START,
    "[ui.sidebar.agents]",
    "rows = [",
    '  ["state_icon", "machine", "workspace", "tab"],',
    '  ["agent"],',
    `  [${token}],`,
    "]",
    "",
    "[ui.sidebar.spaces]",
    "rows = [",
    '  ["state_icon", "workspace"],',
    '  ["branch", "git_status"],',
    `  [${token}],`,
    "]",
    BLOCK_END,
  ].join("\n");
}

export function hasBlock(text) {
  return text.includes(BLOCK_START);
}

export function removeBlock(text) {
  const start = text.indexOf(BLOCK_START);
  if (start < 0) return text;
  const end = text.indexOf(BLOCK_END, start);
  if (end < 0) return text;
  const before = text.slice(0, start).replace(/\n*$/, "\n");
  const after = text.slice(end + BLOCK_END.length).replace(/^\n+/, "");
  return (before + after).replace(/^\n+$/, "");
}

// A user layout we must not override.
export function sidebarConflict(text) {
  const stripped = removeBlock(text);
  return /^\s*\[\s*ui\.sidebar(\.(agents|spaces))?\s*\]/m.test(stripped) || /^\s*sidebar\s*=/m.test(stripped)
    ? "config.toml already defines a [ui.sidebar] layout; add the $rsact_summary token to it manually (see README)"
    : null;
}

export function addBlock(text) {
  if (hasBlock(text)) return text;
  const base = text.length && !text.endsWith("\n") ? `${text}\n` : text;
  return `${base}${base.length ? "\n" : ""}${sidebarBlock()}\n`;
}

// ---- agent config discovery -------------------------------------------------

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function discover(home = os.homedir(), env = process.env) {
  const names = fs.existsSync(home) ? fs.readdirSync(home) : [];
  const pick = (prefix, marker, envVar) => {
    const dirs = names
      .filter((name) => name === prefix || new RegExp(`^${prefix.replace(".", "\\.")}-\\d+$`).test(name))
      .map((name) => path.join(home, name))
      .filter((dir) => isDir(dir) && marker.some((m) => fs.existsSync(path.join(dir, m))));
    if (env[envVar] && isDir(env[envVar]) && !dirs.includes(env[envVar])) dirs.push(env[envVar]);
    return dirs.sort();
  };
  return {
    claude: pick(".claude", ["settings.json", "projects", ".credentials.json"], "CLAUDE_CONFIG_DIR"),
    codex: pick(".codex", ["config.toml", "auth.json"], "CODEX_HOME"),
  };
}

// ---- hook entries -------------------------------------------------------------

export function shimCommand(shim, agent) {
  return `sh '${shim}' ${agent}`;
}

function isOurs(hook, shim) {
  return typeof hook?.command === "string" && hook.command.includes(shim);
}

export function withHooks(settings, { shim, agent, remove = false }) {
  const doc = settings && typeof settings === "object" ? structuredClone(settings) : {};
  doc.hooks ??= {};
  const events = agent === "claude" ? CLAUDE_EVENTS : CODEX_EVENTS;
  // Strip every entry of ours first so upgrades replace stale definitions.
  for (const [event, groups] of Object.entries(doc.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook, shim)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) doc.hooks[event] = kept;
    else delete doc.hooks[event];
  }
  if (!remove) {
    for (const event of events) {
      const hook = { type: "command", command: shimCommand(shim, agent), timeout: 10 };
      if (agent === "claude") hook.async = true;
      const group = { hooks: [hook] };
      if (agent === "claude" && event === "PostToolUse") group.matcher = CLAUDE_TOOL_MATCHER;
      (doc.hooks[event] ??= []).push(group);
    }
  }
  if (Object.keys(doc.hooks).length === 0) delete doc.hooks;
  return doc;
}

export function hookStatus(settings, shim, agent) {
  const events = agent === "claude" ? CLAUDE_EVENTS : CODEX_EVENTS;
  const present = events.filter((event) =>
    (settings?.hooks?.[event] ?? []).some((group) => (group.hooks ?? []).some((hook) => isOurs(hook, shim))),
  );
  return { present: present.length, expected: events.length };
}

// ---- files --------------------------------------------------------------------

export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function writeAtomic(file, text, { backupTag } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`refusing to replace symlink ${file}`);
  }
  if (backupTag && fs.existsSync(file)) {
    const backup = `${file}.bak-${backupTag}`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.agent-activity-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode;
  if (mode !== undefined) fs.chmodSync(tmp, mode & 0o777);
  fs.renameSync(tmp, file);
}

export function hookFile(dir, agent) {
  return path.join(dir, agent === "claude" ? "settings.json" : "hooks.json");
}

export function writeShim(shim, { root, node, stateDir }) {
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const text = [
    "#!/bin/sh",
    "# Installed by the herdr-agent-activity plugin. Safe to delete; it exits",
    "# quietly once the plugin is uninstalled.",
    `ROOT=${quote(root)}`,
    `STATE=${quote(stateDir)}`,
    `NODE=${quote(node)}`,
    '[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null)" || NODE=""',
    'if [ -z "$NODE" ] || [ ! -f "$ROOT/bin/hook.mjs" ]; then cat >/dev/null 2>&1; exit 0; fi',
    'exec "$NODE" "$ROOT/bin/hook.mjs" "$1" --state "$STATE"',
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, text, { mode: 0o755 });
}

export function herdrConfigPath(env = process.env) {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "herdr", "config.toml");
}

// Validates a candidate config with the running herdr binary before writing.
export function checkConfig(herdrBin, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-activity-"));
  const candidate = path.join(dir, "config.toml");
  try {
    fs.writeFileSync(candidate, text);
    execFileSync(herdrBin, ["config", "check"], {
      env: { ...process.env, HERDR_CONFIG_PATH: candidate },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return null;
  } catch (err) {
    return String(err.stderr || err.stdout || err.message).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
