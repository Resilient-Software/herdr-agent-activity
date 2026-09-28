// Activity state -> herdr metadata tokens (contract v1, see CONTRACT.md).

import { nextFire } from "./cron.mjs";

export const CONTRACT_VERSION = "1";
export const SOURCE = "resilient-software.agent-activity";
export const TOKEN_KEYS = [
  "rsact_v",
  "rsact_state",
  "rsact_subagents",
  "rsact_background",
  "rsact_monitors",
  "rsact_next_at",
  "rsact_loop",
  "rsact_summary",
];
const STATE_PRIORITY = ["subagents", "background", "scheduled"];

// Counts are the neutral intermediate form shared by panes and workspaces.
export function countsFromState(state, now = Date.now()) {
  if (!state) return null;
  const shells = Object.values(state.shells);
  let nextAt = state.wakeAt !== null && state.wakeAt > now ? state.wakeAt : null;
  let loop = state.wakeAt !== null && state.wakeAt > now;
  for (const cron of Object.values(state.crons)) {
    const at = nextFire(cron.schedule, now);
    if (at === null) continue;
    if (cron.recurring) loop = true;
    if (nextAt === null || at < nextAt) nextAt = at;
  }
  return {
    subagents: Object.keys(state.subagents).length,
    background: shells.filter((shell) => !shell.monitor).length,
    monitors: shells.filter((shell) => shell.monitor).length,
    nextAt,
    loop,
  };
}

export function mergeCounts(list) {
  const merged = { subagents: 0, background: 0, monitors: 0, nextAt: null, loop: false };
  for (const counts of list) {
    if (!counts) continue;
    merged.subagents += counts.subagents;
    merged.background += counts.background;
    merged.monitors += counts.monitors;
    merged.loop ||= counts.loop;
    if (counts.nextAt !== null && (merged.nextAt === null || counts.nextAt < merged.nextAt)) {
      merged.nextAt = counts.nextAt;
    }
  }
  return merged;
}

export function primaryState(counts) {
  if (!counts) return null;
  if (counts.subagents > 0) return "subagents";
  if (counts.background + counts.monitors > 0) return "background";
  if (counts.nextAt !== null) return "scheduled";
  return null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "14:05" today, "Tue 09:00" within a week, otherwise "3 Oct".
export function when(epochMs, now = Date.now()) {
  const date = new Date(epochMs);
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return hhmm;
  if (epochMs - now < 6 * 24 * 60 * 60 * 1000) return `${DAYS[date.getDay()]} ${hhmm}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// Human summary for the sidebar. Parts appear in priority order so the first
// part names the dominant activity; sidebar colour rules match on it.
export function summary(counts, now = Date.now()) {
  const parts = [];
  if (counts.subagents) parts.push(plural(counts.subagents, "subagent"));
  if (counts.background) parts.push(`${counts.background} bg`);
  if (counts.monitors) parts.push(plural(counts.monitors, "monitor"));
  if (counts.nextAt !== null) parts.push(`${counts.loop ? "loop" : "next"} ${when(counts.nextAt, now)}`);
  return parts.join(" · ");
}

export function tokensFromCounts(counts, now = Date.now()) {
  const state = primaryState(counts);
  const tokens = Object.fromEntries(TOKEN_KEYS.map((key) => [key, null]));
  if (!state) return tokens;
  tokens.rsact_v = CONTRACT_VERSION;
  tokens.rsact_state = state;
  tokens.rsact_subagents = counts.subagents ? String(counts.subagents) : null;
  tokens.rsact_background = counts.background ? String(counts.background) : null;
  tokens.rsact_monitors = counts.monitors ? String(counts.monitors) : null;
  tokens.rsact_next_at = counts.nextAt !== null ? new Date(counts.nextAt).toISOString() : null;
  tokens.rsact_loop = counts.loop ? "1" : null;
  tokens.rsact_summary = summary(counts, now);
  return tokens;
}

// Reads counts back from published tokens (used for workspace rollups).
export function countsFromTokens(tokens) {
  if (!tokens || tokens.rsact_v !== CONTRACT_VERSION || !tokens.rsact_state) return null;
  const int = (value) => (Number.isInteger(Number(value)) ? Number(value) : 0);
  const nextAt = tokens.rsact_next_at ? Date.parse(tokens.rsact_next_at) : NaN;
  return {
    subagents: int(tokens.rsact_subagents ?? 0),
    background: int(tokens.rsact_background ?? 0),
    monitors: int(tokens.rsact_monitors ?? 0),
    nextAt: Number.isFinite(nextAt) ? nextAt : null,
    loop: tokens.rsact_loop === "1",
  };
}

export { STATE_PRIORITY };
