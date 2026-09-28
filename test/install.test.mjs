import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  withHooks,
  hookStatus,
  addBlock,
  removeBlock,
  hasBlock,
  sidebarConflict,
  sidebarBlock,
  discover,
  writeShim,
  CLAUDE_EVENTS,
  CODEX_EVENTS,
} from "../lib/install.mjs";

const SHIM = "/home/u/.config/herdr/plugins/config/resilient-software.agent-activity/hook.sh";

test("hooks install next to existing hooks, idempotently, and uninstall cleanly", () => {
  const original = {
    model: "opus",
    hooks: {
      SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "bash herdr-agent-state.sh session" }] }],
    },
  };
  const once = withHooks(original, { shim: SHIM, agent: "claude" });
  const twice = withHooks(once, { shim: SHIM, agent: "claude" });
  assert.deepEqual(twice, once);
  assert.deepEqual(hookStatus(once, SHIM, "claude"), { present: CLAUDE_EVENTS.length, expected: CLAUDE_EVENTS.length });
  assert.equal(once.hooks.SessionStart.length, 2);
  assert.equal(once.hooks.PostToolUse[0].matcher.includes("Monitor"), true);
  assert.equal(once.hooks.Stop[0].hooks[0].async, true);
  assert.equal(once.model, "opus");
  assert.deepEqual(withHooks(once, { shim: SHIM, agent: "claude", remove: true }), original);
});

test("codex hooks are synchronous and cover the codex events", () => {
  const doc = withHooks({}, { shim: SHIM, agent: "codex" });
  assert.deepEqual(Object.keys(doc.hooks).sort(), [...CODEX_EVENTS].sort());
  assert.equal(doc.hooks.Stop[0].hooks[0].async, undefined);
  assert.deepEqual(withHooks(doc, { shim: SHIM, agent: "codex", remove: true }), {});
});

test("sidebar block is appended once and removed exactly", () => {
  const user = '[ui]\nsidebar_width = 30\n\n[keys]\nprefix = "ctrl+b"\n';
  const added = addBlock(user);
  assert.equal(hasBlock(added), true);
  assert.equal(addBlock(added), added);
  assert.equal(removeBlock(added), user);
  assert.equal(removeBlock(addBlock("")), "");
});

test("an existing user sidebar layout is a conflict, our own block is not", () => {
  assert.match(sidebarConflict('[ui.sidebar.agents]\nrows = [["agent"]]\n'), /manually/);
  assert.equal(sidebarConflict(addBlock('[ui]\nfoo = 1\n')), null);
  assert.ok(sidebarBlock().includes("$rsact_summary"));
});

test("discover finds numbered account homes with config markers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rsact-home-"));
  try {
    for (const dir of [".claude", ".claude-2", ".claude-backup", ".codex", ".codex-3", ".codex-empty"]) {
      fs.mkdirSync(path.join(home, dir));
    }
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    fs.writeFileSync(path.join(home, ".claude-2", "settings.json"), "{}");
    fs.writeFileSync(path.join(home, ".claude-backup", "settings.json"), "{}");
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
    fs.writeFileSync(path.join(home, ".codex-3", "auth.json"), "{}");
    fs.writeFileSync(path.join(home, ".claude.json"), "{}");
    const found = discover(home, {});
    assert.deepEqual(found.claude, [path.join(home, ".claude"), path.join(home, ".claude-2")]);
    assert.deepEqual(found.codex, [path.join(home, ".codex"), path.join(home, ".codex-3")]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the shim exits quietly once the plugin root is gone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsact-shim-"));
  try {
    const shim = path.join(dir, "hook.sh");
    writeShim(shim, { root: path.join(dir, "missing"), node: process.execPath, stateDir: dir });
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("sh", [shim, "claude"], { input: '{"hook_event_name":"Stop"}' });
    assert.equal(result.status, 0);
    assert.equal(String(result.stdout), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
