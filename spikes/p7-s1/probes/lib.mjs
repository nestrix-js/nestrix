// Helpers for the probes: a child process driven over IPC, and a minimal Chrome DevTools
// Protocol client over the inspector's WebSocket (Node's global WebSocket), standing in for an
// attached debugger.
import { fork } from "node:child_process";

export function startChild(file, { execArgv = [], env = {} } = {}) {
  const child = fork(file, [], {
    execArgv,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  let nextId = 1;
  const pending = new Map();
  child.on("message", (m) => {
    if (m?.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) resolve(m.result);
      else reject(new Error(m.error));
    }
  });
  const ready = new Promise((resolve, reject) => {
    child.once("message", (m) =>
      m?.ready ? resolve() : reject(new Error("bad hello")),
    );
    child.once("exit", (code) =>
      reject(new Error(`child exited ${code}: ${stderr}`)),
    );
  });
  return {
    child,
    ready,
    stderr: () => stderr,
    call(cmd, args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, cmd, args });
      });
    },
    kill() {
      child.kill();
    },
  };
}

/** Starts fixtures/app.mjs (or another app speaking the same IPC) and waits for its port. */
export async function startApp(file, env = {}, execArgv = []) {
  const h = startChild(file, { env, execArgv });
  const port = await new Promise((resolve, reject) => {
    h.child.once("message", (m) =>
      m?.port ? resolve(m.port) : reject(new Error("no port")),
    );
    h.child.once("exit", (code) =>
      reject(new Error(`app exited ${code}: ${h.stderr()}`)),
    );
  });
  return { ...h, baseUrl: `http://127.0.0.1:${port}` };
}

/** Waits for "Debugger listening on ws://..." on the child's stderr. */
export async function inspectorUrl(handle, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = /Debugger listening on (ws:\/\/\S+)/.exec(handle.stderr());
    if (m) return m[1];
    if (Date.now() > deadline)
      throw new Error(`no inspector url: ${handle.stderr()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(`${m.error.code}: ${m.error.message}`));
      else resolve(m.result);
    } else if (m.method) events.push(m);
  });
  return {
    events,
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
    },
    async waitFor(method, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = events.findIndex((e) => e.method === method);
        if (i >= 0) return events.splice(i, 1)[0];
        if (Date.now() > deadline) throw new Error(`no ${method}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close() {
      ws.close();
    },
  };
}
