import test from "node:test";
import assert from "node:assert/strict";

import { nextFire } from "../lib/cron.mjs";
import {
  countsFromState,
  countsFromTokens,
  mergeCounts,
  primaryState,
  summary,
  tokensFromCounts,
  TOKEN_KEYS,
} from "../lib/tokens.mjs";
import { emptyState } from "../lib/state.mjs";

const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

test("cron next fire covers steps, ranges, lists, names and day OR semantics", () => {
  const base = local(2026, 9, 28, 12, 7);
  assert.equal(nextFire("*/5 * * * *", base), local(2026, 9, 28, 12, 10));
  assert.equal(nextFire("0 9 * * *", base), local(2026, 9, 29, 9, 0));
  assert.equal(nextFire("30 8 * * mon-fri", base), local(2026, 9, 29, 8, 30)); // Tue 29 Sep
  assert.equal(nextFire("0 0 1 jan *", base), local(2027, 1, 1, 0, 0));
  assert.equal(nextFire("15 10 28 9 *", base), local(2027, 9, 28, 10, 15));
  assert.equal(nextFire("0 12 1 * 3", base), local(2026, 9, 30, 12, 0)); // dom OR dow
  assert.equal(nextFire("@hourly", base), local(2026, 9, 28, 13, 0));
  assert.equal(nextFire("not a cron", base), null);
});

test("counts, primary state and summary follow priority order", () => {
  const now = local(2026, 9, 28, 12, 0);
  const state = {
    ...emptyState("claude"),
    subagents: { a: { label: "x" }, b: { label: "y" } },
    shells: { s: { label: "sleep", monitor: false }, m: { label: "watch", monitor: true } },
    crons: { c: { schedule: "*/15 * * * *", recurring: true, label: "check" } },
  };
  const counts = countsFromState(state, now);
  assert.deepEqual(counts, { subagents: 2, background: 1, monitors: 1, nextAt: local(2026, 9, 28, 12, 15), loop: true });
  assert.equal(primaryState(counts), "subagents");
  assert.equal(summary(counts, now), "2 subagents · 1 bg · 1 monitor · loop 12:15");
});

test("tokens clear every key when idle and round-trip when active", () => {
  const idle = tokensFromCounts({ subagents: 0, background: 0, monitors: 0, nextAt: null, loop: false });
  assert.deepEqual(Object.keys(idle).sort(), [...TOKEN_KEYS].sort());
  assert.ok(Object.values(idle).every((value) => value === null));

  const counts = { subagents: 0, background: 2, monitors: 0, nextAt: Date.UTC(2026, 8, 28, 11, 30), loop: false };
  const tokens = tokensFromCounts(counts);
  assert.equal(tokens.rsact_v, "1");
  assert.equal(tokens.rsact_state, "background");
  assert.equal(tokens.rsact_next_at, "2026-09-28T11:30:00.000Z");
  assert.deepEqual(countsFromTokens(tokens), counts);
});

test("token keys and values respect herdr limits", () => {
  for (const key of TOKEN_KEYS) assert.match(key, /^[A-Za-z0-9_-]{1,32}$/);
  const tokens = tokensFromCounts({ subagents: 12, background: 34, monitors: 5, nextAt: Date.now() + 60_000, loop: true });
  for (const value of Object.values(tokens)) assert.ok(value === null || value.length <= 80);
});

test("workspace rollup sums counts and keeps the earliest next time", () => {
  const merged = mergeCounts([
    { subagents: 1, background: 0, monitors: 0, nextAt: 2000, loop: false },
    null,
    { subagents: 0, background: 1, monitors: 1, nextAt: 1000, loop: true },
  ]);
  assert.deepEqual(merged, { subagents: 1, background: 1, monitors: 1, nextAt: 1000, loop: true });
});

test("countsFromTokens ignores unknown contract versions", () => {
  assert.equal(countsFromTokens({ rsact_v: "2", rsact_state: "background" }), null);
  assert.equal(countsFromTokens({}), null);
});

test("summary times show the day or date beyond today", async () => {
  const { when } = await import("../lib/tokens.mjs");
  const now = local(2026, 9, 28, 12, 0);
  assert.equal(when(local(2026, 9, 28, 14, 5), now), "14:05");
  assert.equal(when(local(2026, 9, 29, 9, 0), now), "Tue 09:00");
  assert.equal(when(local(2027, 9, 28, 10, 7), now), "28 Sep");
});
