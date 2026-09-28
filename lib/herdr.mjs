// Tiny client for the herdr server socket: newline-delimited JSON envelopes.

import net from "node:net";

let counter = 0;

function nextId(prefix) {
  counter += 1;
  return `${prefix}:${process.pid}:${Date.now()}:${counter}`;
}

function lines(socket, onLine) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        // Ignore malformed lines; the server only sends JSON.
      }
    }
  });
}

export function request(socketPath, method, params, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId("rsact");
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`herdr socket timeout: ${method}`));
    }, timeoutMs);
    const finish = (fn) => {
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    socket.on("error", (err) => finish(() => reject(err)));
    lines(socket, (envelope) => {
      if (envelope.id !== id && !(envelope.id === "" && envelope.error)) return;
      if (envelope.error) {
        const err = new Error(envelope.error.message ?? "herdr error");
        err.code = envelope.error.code;
        finish(() => reject(err));
      } else {
        finish(() => resolve(envelope.result));
      }
    });
    socket.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

// Opens a dedicated event stream. Resolves with a close() handle once the
// server acknowledges; onEvent receives { event, data }; onClose fires once.
export function subscribe(socketPath, subscriptions, onEvent, onClose, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId("rsact-sub");
    const socket = net.connect(socketPath);
    let started = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("herdr socket timeout: events.subscribe"));
    }, timeoutMs);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      if (started) onClose();
      else reject(new Error("herdr socket closed before subscription started"));
    });
    lines(socket, (envelope) => {
      if (!started && (envelope.id === id || envelope.error)) {
        clearTimeout(timer);
        if (envelope.error) {
          socket.destroy();
          reject(new Error(envelope.error.message ?? "subscribe failed"));
          return;
        }
        started = true;
        resolve({ close: () => socket.destroy() });
      } else if (started && envelope.event) {
        onEvent({ event: envelope.event, data: envelope.data });
      }
    });
    socket.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n");
  });
}
