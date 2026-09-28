// Pure reducer: agent hook events -> per-session activity state.
//
// State shape (JSON-serialisable, persisted between hook invocations):
// {
//   agent: "claude" | "codex",
//   subagents: { [id]: { label } },
//   shells:    { [id]: { label, monitor: boolean } },
//   crons:     { [id]: { schedule, recurring, label, onceAt? } },
//   wakeAt:    epoch ms | null,     // ScheduleWakeup (dynamic /loop)
// }

import { nextFire } from "./cron.mjs";

const NOTIFICATION = /^\s*<task-notification>/;

export function emptyState(agent) {
  return { agent, subagents: {}, shells: {}, crons: {}, wakeAt: null };
}

function tag(text, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? match[1].trim() : null;
}

function label(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().replace(/\s+/g, " ").slice(0, 60);
    }
  }
  return "";
}

function clone(state) {
  return {
    agent: state.agent,
    subagents: { ...state.subagents },
    shells: { ...state.shells },
    crons: { ...state.crons },
    wakeAt: state.wakeAt ?? null,
  };
}

// `background_tasks` / `session_crons` arrive on Stop and SubagentStop (Claude
// Code 2.1+) and are the authoritative snapshot of what is still pending.
// A one-shot cron fires once at the first match after it was created; its
// pattern (e.g. "50 12 * * *") would otherwise keep matching every day.
function cronEntry(previous, schedule, recurring, label, now) {
  const entry = { schedule, recurring, label };
  if (!recurring) entry.onceAt = previous?.onceAt ?? nextFire(schedule, now);
  return entry;
}

function reconcile(state, event, now) {
  if (Array.isArray(event.background_tasks)) {
    const subagents = {};
    const shells = {};
    for (const task of event.background_tasks) {
      if (!task || typeof task.id !== "string") continue;
      if (task.status && task.status !== "running" && task.status !== "pending") continue;
      if (task.type === "subagent") {
        subagents[task.id] = { label: label(task.description, state.subagents[task.id]?.label, task.agent_type) };
      } else {
        const known = state.shells[task.id];
        shells[task.id] = {
          label: label(task.description, known?.label, task.command),
          monitor: known?.monitor ?? false,
        };
      }
    }
    state.subagents = subagents;
    state.shells = shells;
  }
  if (Array.isArray(event.session_crons)) {
    const crons = {};
    for (const cron of event.session_crons) {
      if (!cron || typeof cron.id !== "string") continue;
      crons[cron.id] = cronEntry(
        state.crons[cron.id],
        String(cron.schedule ?? cron.cron ?? ""),
        Boolean(cron.recurring),
        label(cron.prompt, state.crons[cron.id]?.label),
        now,
      );
    }
    state.crons = crons;
  }
}

function postToolUse(state, event, now) {
  const tool = event.tool_name;
  const input = event.tool_input ?? {};
  const response = event.tool_response ?? {};
  if (tool === "Bash" && typeof response.backgroundTaskId === "string") {
    state.shells[response.backgroundTaskId] = {
      label: label(input.description, input.command),
      monitor: false,
    };
  } else if (tool === "Monitor" && typeof response.taskId === "string") {
    state.shells[response.taskId] = { label: label(input.description, input.command), monitor: true };
  } else if ((tool === "Agent" || tool === "Task") && response.isAsync && typeof response.agentId === "string") {
    state.subagents[response.agentId] = { label: label(input.description, input.subagent_type) };
  } else if (tool === "CronCreate" && typeof response.id === "string") {
    state.crons[response.id] = cronEntry(
      state.crons[response.id],
      String(input.cron ?? ""),
      input.recurring !== false,
      label(input.prompt),
      now,
    );
  } else if (tool === "CronDelete") {
    delete state.crons[input.id];
  } else if (tool === "ScheduleWakeup") {
    const seconds = Number(input.delaySeconds);
    state.wakeAt = input.stop === true || !Number.isFinite(seconds) ? null : now + seconds * 1000;
  } else if (tool === "TaskStop" || tool === "KillShell" || tool === "KillBash") {
    const id = input.task_id ?? input.shell_id ?? input.id;
    delete state.shells[id];
    delete state.subagents[id];
  }
}

function taskNotification(state, prompt) {
  const id = tag(prompt, "task-id");
  if (!id) return;
  const finished = tag(prompt, "status") !== null || /^\[Monitor\b/.test(tag(prompt, "event") ?? "");
  if (finished) {
    delete state.shells[id];
    delete state.subagents[id];
  }
}

export function reduce(previous, event, now = Date.now()) {
  const kind = event?.hook_event_name;
  if (kind === "SessionStart") {
    // Background work never survives a restart, resume, or /clear.
    if (event.source === "compact") return clone(previous);
    return emptyState(previous.agent);
  }
  if (kind === "SessionEnd") return null;

  const state = clone(previous);
  if (state.wakeAt !== null && state.wakeAt <= now) state.wakeAt = null;

  switch (kind) {
    case "PostToolUse":
      postToolUse(state, event, now);
      break;
    case "SubagentStart":
      // Internal helper agents (prompt suggestions, summaries) have no type.
      if (event.agent_id && event.agent_type) {
        state.subagents[event.agent_id] = {
          label: label(state.subagents[event.agent_id]?.label, event.agent_type),
        };
      }
      break;
    case "SubagentStop":
      reconcile(state, event, now);
      // The snapshot on SubagentStop still lists the agent that is stopping.
      if (event.agent_id) delete state.subagents[event.agent_id];
      break;
    case "Stop":
      reconcile(state, event, now);
      break;
    case "UserPromptSubmit":
      if (NOTIFICATION.test(event.prompt ?? "")) taskNotification(state, event.prompt);
      break;
    default:
      break;
  }
  return state;
}

export function isEmpty(state) {
  return (
    !state ||
    (Object.keys(state.subagents).length === 0 &&
      Object.keys(state.shells).length === 0 &&
      Object.keys(state.crons).length === 0 &&
      state.wakeAt === null)
  );
}
