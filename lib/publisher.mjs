// Long-running publisher for one herdr server socket:
//  - recomputes time-based pane tokens (cron / wakeup times) from session state,
//  - clears tokens when the reporting agent has left its pane,
//  - rolls pane tokens up into workspace tokens for the sidebar Space rows.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { request, subscribe } from "./herdr.mjs";
import { commit, reportPaneTokens, nextSeq, TTL_MS } from "./publish.mjs";
import { countsFromTokens, mergeCounts, tokensFromCounts, SOURCE } from "./tokens.mjs";
import { readJson, removeFile, withLock, log } from "./store.mjs";

const TICK_MS = 30_000;
const DEBOUNCE_MS = 300;
const RECONNECT_MS = 2000;
const RECONNECT_ATTEMPTS = 60;
const EVENTS = [
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.exited",
  "pane.agent_detected",
  "workspace.created",
  "workspace.closed",
  "workspace.moved",
].map((type) => ({ type }));

export function pidFile(stateDir, socketPath) {
  const hash = crypto.createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
  return path.join(stateDir, `publisher-${hash}.pid`);
}

export function running(file) {
  const pid = Number(readJson(file)?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function hasActivity(tokens) {
  return Boolean(tokens && tokens.rsact_v);
}

export class Publisher {
  constructor({ socketPath, stateDir }) {
    this.socketPath = socketPath;
    this.stateDir = stateDir;
    this.workspaceCache = new Map();
    this.timer = null;
    this.pending = null;
    this.busy = false;
    this.again = false;
  }

  log(line) {
    log(this.stateDir, `publisher ${line}`);
  }

  schedule(delay = DEBOUNCE_MS) {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.run();
    }, delay);
  }

  async run() {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      await this.tick();
    } catch (err) {
      this.log(`tick error ${err?.code ?? ""} ${err?.message ?? err}`);
    } finally {
      this.busy = false;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  }

  async listPanes() {
    const result = await request(this.socketPath, "pane.list", {});
    return result?.panes ?? [];
  }

  async tick(now = Date.now()) {
    let panes = await this.listPanes();
    const paneById = new Map(panes.map((pane) => [pane.pane_id, pane]));
    const owned = new Set();
    const cleared = new Set();

    // 1. Session state: recompute time-based tokens; drop sessions whose
    //    agent has left the pane.
    const dir = path.join(this.stateDir, "sessions");
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      // No sessions yet.
    }
    let changed = false;
    for (const name of files) {
      const file = path.join(dir, name);
      await withLock(file, async () => {
        const stored = readJson(file);
        if (!stored || stored.socketPath !== this.socketPath) return;
        const pane = paneById.get(stored.paneId);
        if (!pane || pane.agent !== stored.agent) {
          removeFile(file);
          if (pane && hasActivity(pane.tokens)) {
            await reportPaneTokens(this.socketPath, stored.paneId, null, tokensFromCounts(null));
            cleared.add(stored.paneId);
            this.log(`cleared ${stored.paneId}: ${stored.agent} left`);
            changed = true;
          }
          return;
        }
        owned.add(stored.paneId);
        const sent = await commit(file, stored, stored.state, {
          socketPath: this.socketPath,
          paneId: stored.paneId,
          agent: stored.agent,
          now,
        });
        if (sent !== null) {
          this.log(`refreshed ${stored.paneId} -> ${sent}`);
          changed = true;
        }
      });
    }

    // 2. Stray tokens with no live session behind them (e.g. after a crash).
    for (const pane of panes) {
      if (
        hasActivity(pane.tokens) &&
        !owned.has(pane.pane_id) &&
        !cleared.has(pane.pane_id) &&
        !["claude", "codex"].includes(pane.agent)
      ) {
        await reportPaneTokens(this.socketPath, pane.pane_id, null, tokensFromCounts(null));
        this.log(`cleared stray tokens on ${pane.pane_id}`);
        changed = true;
      }
    }
    if (changed) panes = await this.listPanes();

    // 3. Workspace rollups.
    const byWorkspace = new Map();
    for (const pane of panes) {
      const counts = countsFromTokens(pane.tokens);
      if (!byWorkspace.has(pane.workspace_id)) byWorkspace.set(pane.workspace_id, []);
      if (counts) byWorkspace.get(pane.workspace_id).push(counts);
    }
    const workspaces = (await request(this.socketPath, "workspace.list", {}))?.workspaces ?? [];
    for (const workspace of workspaces) {
      const id = workspace.workspace_id;
      const tokens = tokensFromCounts(mergeCounts(byWorkspace.get(id) ?? []));
      const signature = JSON.stringify(tokens);
      const cached = this.workspaceCache.get(id);
      const live = workspace.tokens ?? {};
      const liveMatches = (live.rsact_summary ?? null) === tokens.rsact_summary && (live.rsact_v ?? null) === tokens.rsact_v;
      const fresh = cached && cached.signature === signature && now - cached.at < TTL_MS / 6;
      if (liveMatches && (fresh || tokens.rsact_state === null)) continue;
      await request(this.socketPath, "workspace.report_metadata", {
        workspace_id: id,
        source: SOURCE,
        tokens,
        seq: nextSeq(),
        ...(tokens.rsact_state ? { ttl_ms: TTL_MS } : {}),
      });
      this.workspaceCache.set(id, { signature, at: now });
      this.log(`workspace ${id} -> ${tokens.rsact_summary ?? "clear"}`);
    }
    for (const id of this.workspaceCache.keys()) {
      if (!workspaces.some((workspace) => workspace.workspace_id === id)) this.workspaceCache.delete(id);
    }
  }

  async connect() {
    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt += 1) {
      try {
        await new Promise((resolve, reject) => {
          subscribe(
            this.socketPath,
            EVENTS,
            () => this.schedule(),
            () => resolve(),
          )
            .then(() => {
              if (attempt > 0) this.log("reconnected");
              attempt = 0;
              this.schedule(0);
            })
            .catch(reject);
        });
        this.log("event stream closed");
      } catch (err) {
        if (attempt === 0) this.log(`subscribe failed: ${err?.message ?? err}`);
      }
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  }

  async start() {
    this.log(`started pid=${process.pid} socket=${this.socketPath}`);
    this.timer = setInterval(() => this.run(), TICK_MS);
    await this.connect();
    clearInterval(this.timer);
    this.log("giving up: herdr server unreachable");
  }
}
