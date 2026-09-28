import test from "node:test";
import assert from "node:assert/strict";

import { reduce, emptyState, isEmpty } from "../lib/state.mjs";

const NOW = Date.UTC(2026, 8, 28, 11, 0, 0);

function run(events, start = emptyState("claude")) {
  return events.reduce((state, event) => reduce(state, event, NOW), start);
}

const bgBash = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "sleep 40", description: "Wait a bit", run_in_background: true },
  tool_response: { stdout: "", backgroundTaskId: "b1" },
};
const asyncAgent = {
  hook_event_name: "PostToolUse",
  tool_name: "Agent",
  tool_input: { description: "Count files", subagent_type: "Explore" },
  tool_response: { isAsync: true, status: "async_launched", agentId: "a1" },
};
const monitor = {
  hook_event_name: "PostToolUse",
  tool_name: "Monitor",
  tool_input: { description: "watch build", command: "tail -f x" },
  tool_response: { taskId: "m1", timeoutMs: 60000, persistent: false },
};

function notification(id, body) {
  return { hook_event_name: "UserPromptSubmit", prompt: `<task-notification>\n<task-id>${id}</task-id>\n${body}\n</task-notification>` };
}

test("background bash, async agents and monitors are tracked from PostToolUse", () => {
  const state = run([bgBash, asyncAgent, monitor]);
  assert.deepEqual(Object.keys(state.shells).sort(), ["b1", "m1"]);
  assert.equal(state.shells.m1.monitor, true);
  assert.equal(state.shells.b1.monitor, false);
  assert.deepEqual(Object.keys(state.subagents), ["a1"]);
});

test("foreground Bash results do not count as background work", () => {
  const state = run([{ ...bgBash, tool_response: { stdout: "ok" } }]);
  assert.equal(isEmpty(state), true);
});

test("SubagentStart counts typed subagents and ignores untyped internal helpers", () => {
  const state = run([
    { hook_event_name: "SubagentStart", agent_id: "a2", agent_type: "Explore" },
    { hook_event_name: "SubagentStart", agent_id: "helper", agent_type: "" },
  ]);
  assert.deepEqual(Object.keys(state.subagents), ["a2"]);
});

test("SubagentStop removes the stopping agent even though its snapshot still lists it", () => {
  const state = run([
    bgBash,
    asyncAgent,
    {
      hook_event_name: "SubagentStop",
      agent_id: "a1",
      agent_type: "Explore",
      background_tasks: [
        { id: "b1", type: "shell", status: "running", description: "Wait a bit" },
        { id: "a1", type: "subagent", status: "running", description: "Count files" },
      ],
      session_crons: [],
    },
  ]);
  assert.deepEqual(Object.keys(state.subagents), []);
  assert.deepEqual(Object.keys(state.shells), ["b1"]);
});

test("Stop reconciles from the authoritative snapshot and keeps monitor flags", () => {
  const state = run([
    bgBash,
    monitor,
    {
      hook_event_name: "Stop",
      background_tasks: [{ id: "m1", type: "shell", status: "running", description: "watch build" }],
      session_crons: [{ id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "check CI" }],
    },
  ]);
  assert.deepEqual(Object.keys(state.shells), ["m1"]);
  assert.equal(state.shells.m1.monitor, true);
  assert.equal(state.crons.c1.recurring, true);
});

test("task notifications with a status finish the task", () => {
  const state = run([bgBash, asyncAgent, notification("b1", "<status>completed</status>"), notification("a1", "<status>completed</status>")]);
  assert.equal(isEmpty(state), true);
});

test("monitor events keep the monitor; bracketed monitor lifecycle events end it", () => {
  const afterEvent = run([monitor, notification("m1", "<summary>Monitor event</summary>\n<event>build ok</event>")]);
  assert.ok(afterEvent.shells.m1);
  const afterExpiry = reduce(afterEvent, notification("m1", "<event>[Monitor expired after 1m with 1 event delivered.]</event>"), NOW);
  assert.equal(afterExpiry.shells.m1, undefined);
});

test("TaskStop removes a task", () => {
  const state = run([bgBash, { hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "b1" }, tool_response: {} }]);
  assert.equal(isEmpty(state), true);
});

test("CronCreate and CronDelete maintain crons", () => {
  const created = run([
    { hook_event_name: "PostToolUse", tool_name: "CronCreate", tool_input: { cron: "0 9 * * *", prompt: "standup", recurring: true }, tool_response: { id: "c9" } },
  ]);
  assert.equal(created.crons.c9.schedule, "0 9 * * *");
  const deleted = reduce(created, { hook_event_name: "PostToolUse", tool_name: "CronDelete", tool_input: { id: "c9" }, tool_response: {} }, NOW);
  assert.equal(isEmpty(deleted), true);
});

test("ScheduleWakeup sets a wake time that expires on its own", () => {
  const state = run([{ hook_event_name: "PostToolUse", tool_name: "ScheduleWakeup", tool_input: { delaySeconds: 300 }, tool_response: {} }]);
  assert.equal(state.wakeAt, NOW + 300_000);
  const later = reduce(state, { hook_event_name: "Stop" }, NOW + 301_000);
  assert.equal(later.wakeAt, null);
});

test("an ordinary prompt does not cancel a pending wakeup", () => {
  const state = run([
    { hook_event_name: "PostToolUse", tool_name: "ScheduleWakeup", tool_input: { delaySeconds: 300 }, tool_response: {} },
    { hook_event_name: "UserPromptSubmit", prompt: "hello" },
  ]);
  assert.equal(state.wakeAt, NOW + 300_000);
});

test("SessionStart resets except after compaction; SessionEnd drops the session", () => {
  const busy = run([bgBash]);
  assert.equal(isEmpty(reduce(busy, { hook_event_name: "SessionStart", source: "resume" }, NOW)), true);
  assert.ok(reduce(busy, { hook_event_name: "SessionStart", source: "compact" }, NOW).shells.b1);
  assert.equal(reduce(busy, { hook_event_name: "SessionEnd" }, NOW), null);
});

test("Codex-style Stop without snapshots leaves state alone", () => {
  const state = run([{ hook_event_name: "SubagentStart", agent_id: "t1", agent_type: "worker" }, { hook_event_name: "Stop" }], emptyState("codex"));
  assert.deepEqual(Object.keys(state.subagents), ["t1"]);
});

test("a one-shot cron with a daily-looking pattern fires once, then drops out", async () => {
  const { countsFromState } = await import("../lib/tokens.mjs");
  const at = (h, m, day = 28) => new Date(2026, 8, day, h, m).getTime();
  const created = reduce(
    emptyState("claude"),
    {
      hook_event_name: "PostToolUse",
      tool_name: "CronCreate",
      tool_input: { cron: "50 12 * * *", prompt: "check again", recurring: false },
      tool_response: { id: "once" },
    },
    at(12, 33),
  );
  assert.equal(countsFromState(created, at(12, 40)).nextAt, at(12, 50));
  // After it fires the pattern would match again tomorrow; it must not.
  assert.equal(countsFromState(created, at(12, 51)).nextAt, null);
  // A later snapshot that still lists it (before Claude deletes it) keeps the original time.
  const snapshot = reduce(
    created,
    { hook_event_name: "Stop", session_crons: [{ id: "once", schedule: "50 12 * * *", recurring: false, prompt: "check again" }] },
    at(12, 51),
  );
  assert.equal(snapshot.crons.once.onceAt, at(12, 50));
  assert.equal(countsFromState(snapshot, at(12, 51)).nextAt, null);
});
