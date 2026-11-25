// Fake Ollama for the parity harness (added by Wave 3, ai; see STATUS.md).
//
// One HTTP server on 127.0.0.1 that both the Node and the Rust server are
// pointed at through the same OLLAMA_URL. It never contacts anything else.
//
// - Requests are attributed to the server that sent them by `User-Agent`:
//   Node's fetch (undici) always sends `node`; the Rust client sends none.
//   Every request is recorded per server ({ method, path, body }) so a scenario
//   can assert both servers sent Ollama exactly the same requests.
// - Replies are scripted. Each server has its own queue (the scenario loads the
//   same script into both), consumed in order by every POST /api/chat:
//     { "json": {...}, "status"?: 200 }   a JSON reply (non-streaming turns)
//     { "message": {...} }                shorthand for { json: { model, message, done: true } }
//     { "text": "...", "status": 500 }    a plain-text reply
//     { "stream": [line | {gate} | {delayMs}], "status"?: 200 }
//                                          NDJSON, one write per line; a string
//                                          is written as-is plus "\n", an object
//                                          as JSON plus "\n"; { "gate": "g" }
//                                          holds the stream until released;
//                                          { "delayMs": n } pauses
//     { "destroy": true }                 drops the connection (fetch fails)
//   An exhausted queue answers 500 "fake-ollama: script exhausted".
// - GET /api/tags answers `tags` (default { models: [] }), or drops the
//   connection when tags is "destroy", or `{ status, text }`.
import * as http from "node:http";

export async function startFakeOllama() {
  const kinds = ["node", "rust"];
  const state = {};
  const reset = () => {
    for (const k of kinds) state[k] = { queue: [], requests: [], tags: { json: { models: [] } } };
  };
  reset();
  const gates = new Map(); // name -> { released, waiters[] }
  const gate = (name) => {
    if (!gates.has(name)) gates.set(name, { released: false, waiters: [] });
    return gates.get(name);
  };
  const sockets = new Set();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const server = http.createServer(async (req, res) => {
    const kind = req.headers["user-agent"] === "node" ? "node" : "rust";
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { unparsedBody: raw };
      }
    }
    const url = new URL(req.url, "http://x");
    state[kind].requests.push({ method: req.method, path: url.pathname, body });

    if (req.method === "GET" && url.pathname === "/api/tags") {
      return reply(res, state[kind].tags);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const next = state[kind].queue.shift();
      if (!next) return reply(res, { status: 500, text: "fake-ollama: script exhausted" });
      return reply(res, next);
    }
    return reply(res, { status: 404, text: "404 page not found" });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  async function reply(res, r) {
    if (r === "destroy" || r.destroy) {
      res.socket.destroy();
      return;
    }
    const status = r.status ?? 200;
    if (r.stream) {
      res.writeHead(status, { "Content-Type": "application/x-ndjson" });
      for (const item of r.stream) {
        if (item && typeof item === "object" && "gate" in item) {
          const g = gate(item.gate);
          if (!g.released) await new Promise((resolve) => g.waiters.push(resolve));
          continue;
        }
        if (item && typeof item === "object" && "delayMs" in item) {
          await sleep(item.delayMs);
          continue;
        }
        if (res.destroyed) return;
        res.write(typeof item === "string" ? `${item}\n` : `${JSON.stringify(item)}\n`);
        // Separate writes, so each line arrives in its own chunk.
        await sleep(15);
      }
      res.end();
      return;
    }
    if ("text" in r) {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(r.text);
      return;
    }
    const json = r.message
      ? { model: "fake", created_at: "2026-01-01T00:00:00Z", message: r.message, done: true }
      : r.json;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(json));
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    /** Clears queues, logs, tags and gates (between scenarios). */
    reset() {
      reset();
      for (const g of gates.values()) for (const w of g.waiters) w();
      gates.clear();
    },
    /** Loads the same script into both servers' queues (appends). */
    script(items) {
      for (const k of kinds) state[k].queue.push(...structuredClone(items));
    },
    setTags(tags) {
      for (const k of kinds) state[k].tags = structuredClone(tags);
    },
    release(name) {
      const g = gate(name);
      g.released = true;
      for (const w of g.waiters.splice(0)) w();
    },
    /** Returns and clears the requests one server sent. */
    takeRequests(kind) {
      const out = state[kind].requests;
      state[kind].requests = [];
      return out;
    },
    remaining(kind) {
      return state[kind].queue.length;
    },
    async close() {
      for (const g of gates.values()) for (const w of g.waiters) w();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
