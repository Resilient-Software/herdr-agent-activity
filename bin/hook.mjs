#!/usr/bin/env node
// Agent hook entry point: `hook.mjs <claude|codex> --state <dir>` with the
// hook event JSON on stdin. Always exits 0 so it can never break an agent.

import { reduce, emptyState } from "../lib/state.mjs";
import { commit } from "../lib/publish.mjs";
import { sessionFile, readJson, withLock, log } from "../lib/store.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const agent = process.argv[2];
  const stateDir = arg("--state");
  if (!["claude", "codex"].includes(agent) || !stateDir) return;
  if (process.env.HERDR_ENV !== "1") return;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (!socketPath || !paneId) return;

  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const sessionId = event?.session_id;
  if (typeof sessionId !== "string" || !sessionId) return;
  // Codex child threads inherit the parent's thread id; only the root session
  // owns the pane.
  const inherited = process.env.CODEX_THREAD_ID;
  if (agent === "codex" && inherited && inherited !== sessionId) return;

  const file = sessionFile(stateDir, agent, sessionId);
  await withLock(file, async () => {
    const stored = readJson(file);
    const next = reduce(stored?.state ?? emptyState(agent), event);
    const sent = await commit(file, stored, next, { socketPath, paneId, agent });
    if (sent !== null) {
      const what = `${event.hook_event_name}${event.tool_name ? `:${event.tool_name}` : ""}`;
      log(stateDir, `hook ${paneId} ${agent} ${what} -> ${sent}`);
    }
  });
}

main().catch((err) => {
  const stateDir = arg("--state");
  if (stateDir) log(stateDir, `hook error ${process.argv[2]} ${err?.code ?? ""} ${err?.message ?? err}`);
});
