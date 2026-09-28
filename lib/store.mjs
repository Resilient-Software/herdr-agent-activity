// Session state files, a cross-process lock, and a size-capped log.

import fs from "node:fs";
import path from "node:path";

const LOCK_STALE_MS = 5000;
const LOG_MAX_BYTES = 1024 * 1024;

export function sessionFile(stateDir, agent, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(stateDir, "sessions", `${agent}-${safe}.json`);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

// mkdir is atomic on every platform we support, so it doubles as a mutex.
export async function withLock(file, fn, { timeoutMs = 3000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // Raced with the holder releasing it.
      }
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function log(stateDir, line) {
  try {
    const file = path.join(stateDir, "activity.log");
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // No log yet.
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never break an agent hook.
  }
}
