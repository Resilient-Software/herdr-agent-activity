#!/usr/bin/env node
// Plugin entry point: install | uninstall | startup | doctor | publisher

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  discover,
  withHooks,
  hookStatus,
  hookFile,
  readText,
  writeAtomic,
  writeShim,
  herdrConfigPath,
  checkConfig,
  addBlock,
  removeBlock,
  hasBlock,
  sidebarConflict,
} from "../lib/install.mjs";
import { request } from "../lib/herdr.mjs";
import { Publisher, pidFile, running } from "../lib/publisher.mjs";
import { reportPaneTokens, nextSeq } from "../lib/publish.mjs";
import { tokensFromCounts, SOURCE } from "../lib/tokens.mjs";
import { readJson, writeJson, log } from "../lib/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const configDir = env.HERDR_PLUGIN_CONFIG_DIR;
const stateDir = env.HERDR_PLUGIN_STATE_DIR;
const socketPath = env.HERDR_SOCKET_PATH;
const herdrBin = env.HERDR_BIN_PATH || "herdr";
const BACKUP_TAG = "agent-activity";

// Prefer a stable node path: Homebrew's execPath points into a versioned
// Cellar directory that disappears on upgrade.
function stableNode() {
  const real = fs.realpathSync(process.execPath);
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "node");
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch {
      // Not in this PATH entry.
    }
  }
  return process.execPath;
}

function need(value, name) {
  if (!value) {
    console.error(`${name} is not set; run this through herdr (herdr plugin action invoke ...)`);
    process.exit(2);
  }
  return value;
}

const shimPath = () => path.join(need(configDir, "HERDR_PLUGIN_CONFIG_DIR"), "hook.sh");
const recordPath = () => path.join(need(stateDir, "HERDR_PLUGIN_STATE_DIR"), "install.json");

function settingsOverride() {
  return readJson(path.join(configDir, "config.json")) ?? {};
}

function targets() {
  const override = settingsOverride();
  const found = discover();
  return {
    claude: Array.isArray(override.claude) ? override.claude : found.claude,
    codex: Array.isArray(override.codex) ? override.codex : found.codex,
    sidebar: override.sidebar !== false,
  };
}

function applyHooks(dirs, agent, remove) {
  const results = [];
  for (const dir of dirs) {
    const file = hookFile(dir, agent);
    try {
      const text = readText(file);
      if (text === null && remove) continue;
      const current = text === null || !text.trim() ? {} : JSON.parse(text);
      const next = withHooks(current, { shim: shimPath(), agent, remove });
      const serialised = `${JSON.stringify(next, null, 2)}\n`;
      if (text !== null && JSON.stringify(current) === JSON.stringify(next)) {
        results.push(`${file}: unchanged`);
        continue;
      }
      writeAtomic(file, serialised, { backupTag: BACKUP_TAG });
      results.push(`${file}: ${remove ? "removed" : "installed"}`);
    } catch (err) {
      results.push(`${file}: FAILED ${err.message}`);
    }
  }
  return results;
}

async function reloadConfig() {
  if (!socketPath) return "no server socket; restart herdr to load the sidebar layout";
  try {
    await request(socketPath, "server.reload_config", {});
    return "reloaded herdr config";
  } catch (err) {
    return `config reload failed: ${err.message}`;
  }
}

async function applySidebar(remove) {
  const file = herdrConfigPath();
  const text = readText(file) ?? "";
  if (remove) {
    if (!hasBlock(text)) return `${file}: no managed sidebar block`;
    writeAtomic(file, removeBlock(text), { backupTag: BACKUP_TAG });
    return `${file}: sidebar block removed; ${await reloadConfig()}`;
  }
  if (hasBlock(text)) return `${file}: sidebar block present`;
  const conflict = sidebarConflict(text);
  if (conflict) return `${file}: skipped — ${conflict}`;
  const next = addBlock(text);
  const invalid = checkConfig(herdrBin, next);
  if (invalid) return `${file}: skipped — herdr rejected the layout: ${invalid}`;
  writeAtomic(file, next, { backupTag: BACKUP_TAG });
  return `${file}: sidebar block added; ${await reloadConfig()}`;
}

function startPublisher() {
  if (!socketPath) return "no server socket; publisher not started";
  const pid = running(pidFile(stateDir, socketPath));
  if (pid) return `publisher already running (pid ${pid})`;
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "cli.mjs"), "publisher"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  return `publisher started (pid ${child.pid})`;
}

function stopPublisher() {
  if (!socketPath) return "no server socket";
  const pid = running(pidFile(stateDir, socketPath));
  if (!pid) return "publisher not running";
  process.kill(pid, "SIGTERM");
  return `publisher stopped (pid ${pid})`;
}

async function clearAllTokens() {
  if (!socketPath) return 0;
  let cleared = 0;
  const empty = tokensFromCounts(null);
  const panes = (await request(socketPath, "pane.list", {}))?.panes ?? [];
  for (const pane of panes) {
    if (pane.tokens?.rsact_v) {
      await reportPaneTokens(socketPath, pane.pane_id, null, empty);
      cleared += 1;
    }
  }
  const workspaces = (await request(socketPath, "workspace.list", {}))?.workspaces ?? [];
  for (const workspace of workspaces) {
    if (workspace.tokens?.rsact_v) {
      await request(socketPath, "workspace.report_metadata", {
        workspace_id: workspace.workspace_id,
        source: SOURCE,
        tokens: empty,
        seq: nextSeq(),
      });
      cleared += 1;
    }
  }
  return cleared;
}

async function install() {
  const t = targets();
  writeShim(shimPath(), { root: ROOT, node: stableNode(), stateDir });
  const lines = [`shim ${shimPath()}`];
  lines.push(...applyHooks(t.claude, "claude", false));
  lines.push(...applyHooks(t.codex, "codex", false));
  if (t.sidebar) lines.push(await applySidebar(false));
  writeJson(recordPath(), { claude: t.claude, codex: t.codex, sidebar: t.sidebar, installedAt: new Date().toISOString() });
  lines.push(startPublisher());
  if (t.codex.length) lines.push("Codex asks you to review the new hooks once per account on next launch.");
  lines.push("Restart running agents (or start new ones) to pick up the hooks.");
  log(stateDir, `install: ${lines.join(" | ")}`);
  console.log(lines.join("\n"));
}

async function uninstall() {
  const record = readJson(recordPath()) ?? {};
  const found = discover();
  const union = (a = [], b = []) => [...new Set([...a, ...b])];
  const lines = [stopPublisher()];
  lines.push(...applyHooks(union(record.claude, found.claude), "claude", true));
  lines.push(...applyHooks(union(record.codex, found.codex), "codex", true));
  lines.push(await applySidebar(true));
  try {
    lines.push(`cleared tokens on ${await clearAllTokens()} panes/workspaces`);
  } catch (err) {
    lines.push(`token cleanup skipped: ${err.message}`);
  }
  for (const file of [shimPath(), recordPath()]) fs.rmSync(file, { force: true });
  fs.rmSync(path.join(stateDir, "sessions"), { recursive: true, force: true });
  log(stateDir, `uninstall: ${lines.join(" | ")}`);
  console.log(lines.join("\n"));
}

async function startup() {
  const record = readJson(recordPath());
  if (!record) {
    log(stateDir, "startup: not installed; run the install action");
    return;
  }
  // Repair: the plugin may have moved (reinstall) or an agent integration
  // reinstall may have rewritten settings files.
  writeShim(shimPath(), { root: ROOT, node: stableNode(), stateDir });
  const repaired = [
    ...applyHooks(record.claude ?? [], "claude", false),
    ...applyHooks(record.codex ?? [], "codex", false),
  ].filter((line) => !line.endsWith("unchanged"));
  if (record.sidebar) {
    const text = readText(herdrConfigPath()) ?? "";
    if (!hasBlock(text) && !sidebarConflict(text)) repaired.push(await applySidebar(false));
  }
  log(stateDir, `startup: ${repaired.length ? repaired.join(" | ") : "hooks ok"}; ${startPublisher()}`);
}

async function doctor() {
  const record = readJson(recordPath());
  const lines = [`plugin root: ${ROOT}`, `node: ${stableNode()}`, `installed: ${record ? record.installedAt : "no"}`];
  const shim = shimPath();
  lines.push(`shim: ${fs.existsSync(shim) ? shim : "missing"}`);
  for (const [agent, dirs] of [
    ["claude", record?.claude ?? discover().claude],
    ["codex", record?.codex ?? discover().codex],
  ]) {
    for (const dir of dirs) {
      const text = readText(hookFile(dir, agent));
      const status = hookStatus(text ? JSON.parse(text) : {}, shim, agent);
      lines.push(`${agent} ${dir}: ${status.present}/${status.expected} hooks`);
    }
  }
  const config = readText(herdrConfigPath()) ?? "";
  lines.push(
    `sidebar: ${hasBlock(config) ? "managed block present" : sidebarConflict(config) ? "user layout (add $rsact_summary manually)" : "not configured"}`,
  );
  if (socketPath) {
    const pid = running(pidFile(stateDir, socketPath));
    lines.push(`publisher: ${pid ? `running (pid ${pid})` : "not running"}`);
    try {
      const panes = (await request(socketPath, "pane.list", {}))?.panes ?? [];
      const active = panes.filter((pane) => pane.tokens?.rsact_v);
      lines.push(`active panes: ${active.map((pane) => `${pane.pane_id}=${pane.tokens.rsact_summary}`).join(", ") || "none"}`);
    } catch (err) {
      lines.push(`server: ${err.message}`);
    }
  }
  const logFile = path.join(stateDir, "activity.log");
  const tail = (readText(logFile) ?? "").trim().split("\n").slice(-8);
  lines.push(`log (${logFile}):`, ...tail.map((line) => `  ${line}`));
  console.log(lines.join("\n"));
}

async function publisher() {
  need(socketPath, "HERDR_SOCKET_PATH");
  const file = pidFile(stateDir, socketPath);
  const other = running(file);
  if (other && other !== process.pid) return;
  writeJson(file, { pid: process.pid, socketPath, startedAt: new Date().toISOString() });
  const cleanup = () => {
    if (readJson(file)?.pid === process.pid) fs.rmSync(file, { force: true });
  };
  process.on("SIGTERM", () => {
    log(stateDir, `publisher stopped pid=${process.pid}`);
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);
  await new Publisher({ socketPath, stateDir }).start();
}

const commands = { install, uninstall, startup, doctor, publisher };
const command = commands[process.argv[2]];
if (!command) {
  console.error(`usage: cli.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
need(stateDir, "HERDR_PLUGIN_STATE_DIR");
command().catch((err) => {
  log(stateDir, `${process.argv[2]} error: ${err?.stack ?? err}`);
  console.error(err?.message ?? err);
  process.exit(1);
});
