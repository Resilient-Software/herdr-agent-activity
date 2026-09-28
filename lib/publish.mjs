// Shared "state -> pane tokens" commit used by the hook and the publisher.

import { isEmpty } from "./state.mjs";
import { countsFromState, tokensFromCounts, SOURCE } from "./tokens.mjs";
import { request } from "./herdr.mjs";
import { writeJson, removeFile } from "./store.mjs";

export const TTL_MS = 6 * 60 * 60 * 1000;
const REFRESH_MS = TTL_MS / 6;

let seqCounter = 0;
export function nextSeq() {
  seqCounter = (seqCounter + 1) % 1000;
  return Date.now() * 1000 + seqCounter;
}

export function reportPaneTokens(socketPath, paneId, agent, tokens) {
  const active = tokens.rsact_state !== null;
  return request(socketPath, "pane.report_metadata", {
    pane_id: paneId,
    source: SOURCE,
    ...(agent ? { agent } : {}),
    tokens,
    seq: nextSeq(),
    ...(active ? { ttl_ms: TTL_MS } : {}),
  });
}

// Persists `next` for the session and publishes its tokens when they changed.
// Returns the published summary (or "clear"), or null when nothing was sent.
// Callers must hold the session lock.
export async function commit(file, stored, next, { socketPath, paneId, agent, now = Date.now() }) {
  const tokens = tokensFromCounts(next ? countsFromState(next, now) : null);
  const active = tokens.rsact_state !== null;
  const signature = JSON.stringify(tokens);
  const moved = Boolean(stored?.paneId && stored.paneId !== paneId);
  const unchanged = !moved && stored?.published === signature && now - (stored.publishedAt ?? 0) < REFRESH_MS;
  const neverPublished = !stored?.published && !active;

  let sent = null;
  if (!unchanged && !neverPublished) {
    await reportPaneTokens(socketPath, paneId, agent, tokens);
    sent = tokens.rsact_summary ?? "clear";
  }
  if (moved && stored.socketPath) {
    // The session moved panes (rare); clear what it left behind.
    await reportPaneTokens(stored.socketPath, stored.paneId, null, tokensFromCounts(null)).catch(() => {});
  }

  if (next === null || (isEmpty(next) && !active)) {
    removeFile(file);
  } else {
    writeJson(file, {
      agent,
      paneId,
      socketPath,
      updatedAt: now,
      state: next,
      published: sent === null ? stored?.published : signature,
      publishedAt: sent === null ? stored?.publishedAt : now,
    });
  }
  return sent;
}
