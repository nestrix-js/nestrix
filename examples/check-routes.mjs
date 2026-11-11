// Hits every fixture route and compares the result with the table in
// docs/backlog/phase-0.md (P0-04). Shared by all example apps.
//
//   node examples/check-routes.mjs [baseUrl]     (default: $BASE_URL or http://127.0.0.1:3000)
//
// Exits 1 if any route does not match.

const base = (
  process.argv[2] ??
  process.env.BASE_URL ??
  "http://127.0.0.1:3000"
).replace(/\/$/, "");

const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const uploadForm = () => {
  const form = new FormData();
  form.append("note", "ignored text field");
  form.append("file", new Blob(["hello upload"]), "hello.txt");
  return { method: "POST", body: form };
};

const checks = [
  { path: "/hello", status: 200, body: (t) => t === "hello" },
  {
    path: "/users/42",
    status: 200,
    body: (t) => JSON.parse(t).id === "42",
  },
  { path: "/private", status: 403 },
  { path: "/private-method", status: 403 },
  { path: "/boom", status: 500 },
  { path: "/teapot", status: 418 },
  {
    path: "/stream",
    status: 200,
    // Four chunks, 250 ms apart: at least ~1 s end to end.
    custom: async (res, t0) => {
      let chunks = 0;
      let text = "";
      for await (const chunk of res.body) {
        chunks++;
        text += Buffer.from(chunk).toString();
      }
      const ms = Math.round(performance.now() - t0);
      const ok = text === "chunk 1\nchunk 2\nchunk 3\nchunk 4\n" && ms >= 900;
      return { ok, note: `${chunks} reads, ${ms} ms` };
    },
  },
  {
    method: "POST",
    path: "/echo",
    status: 201,
    init: () => json({ a: 1, nested: { b: [true, null] } }),
    body: (t) => t === '{"a":1,"nested":{"b":[true,null]}}',
  },
  {
    method: "POST",
    path: "/upload",
    status: 201,
    init: uploadForm,
    body: (t) => {
      const o = JSON.parse(t);
      return o.name === "hello.txt" && o.size === 12;
    },
  },
  {
    path: "/out",
    status: 200,
    body: (t) => {
      const o = JSON.parse(t);
      return o.fetch === 200 && o.http === 200;
    },
  },
];

// Express apps (express-esm, express-cjs) also mount Nest's multer FileInterceptor.
if (process.env.CHECK_EXPRESS_ROUTES === "1") {
  checks.push({
    method: "POST",
    path: "/upload-multer",
    status: 201,
    init: uploadForm,
    body: (t) => {
      const o = JSON.parse(t);
      return o.name === "hello.txt" && o.size === 12;
    },
  });
}

let failed = 0;
console.log(`base ${base}`);
console.log("METHOD PATH EXPECTED ACTUAL RESULT");
for (const c of checks) {
  const method = c.method ?? "GET";
  let actual = "error";
  let ok = false;
  let note = "";
  try {
    const t0 = performance.now();
    const res = await fetch(base + c.path, c.init ? c.init() : undefined);
    actual = res.status;
    if (c.custom) {
      const r = await c.custom(res, t0);
      ok = actual === c.status && r.ok;
      note = r.note;
    } else {
      const text = await res.text();
      ok = actual === c.status && (c.body ? c.body(text) : true);
      note = text.length > 60 ? `${text.slice(0, 60)}...` : text;
    }
  } catch (err) {
    note = String(err);
  }
  if (!ok) failed++;
  console.log(
    `${method} ${c.path} ${c.status} ${actual} ${ok ? "ok" : "MISMATCH"}  ${note.replace(/\n/g, "\\n")}`,
  );
}

if (failed > 0) {
  console.error(`${failed} route(s) did not match`);
  process.exit(1);
}
console.log("all routes match");
