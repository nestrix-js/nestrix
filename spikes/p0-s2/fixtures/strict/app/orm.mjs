// Q5/Q6 probe, ESM. Plain `node orm.mjs`, no flags. PG_URL must be set.
// ORMS=raw,typeorm,drizzle,mikro,prisma selects what runs; SCAN=1 additionally wraps
// every pg copy in the module cache (candidate fix for nested copies) and reruns.
import {
  enable,
  finishedSpans,
  instrumentLoadedPgCopies,
  loadedPgCopies,
  withSpan,
} from "nestrix-standin";

const url = process.env.PG_URL;
const wanted = new Set(
  (process.env.ORMS ?? "raw,typeorm,drizzle,mikro,prisma").split(","),
);
const report = enable();
const runs = {};
const errors = {};
const closers = [];

async function probe(name, fn) {
  try {
    const { spanId, result } = await withSpan(`orm ${name}`, fn);
    runs[name] = { spanId, result: JSON.stringify(result).slice(0, 200) };
  } catch (e) {
    errors[name] = `${e?.name}: ${e?.message}`.slice(0, 500);
  }
}

const setups = {
  async raw() {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    closers.push(() => client.end());
    return () => client.query("SELECT 10 AS n").then((r) => r.rows);
  },
  async typeorm() {
    const { DataSource } = await import("typeorm");
    const ds = new DataSource({ type: "postgres", url, entities: [] });
    await ds.initialize();
    closers.push(() => ds.destroy());
    return () => ds.query("SELECT 11 AS n");
  },
  async drizzle() {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { sql } = await import("drizzle-orm");
    const db = drizzle(url);
    closers.push(() => db.$client.end());
    return () => db.execute(sql`SELECT 12 AS n`).then((r) => r.rows);
  },
  async mikro() {
    const { MikroORM } = await import("@mikro-orm/postgresql");
    const orm = await MikroORM.init({
      clientUrl: url,
      entities: [],
      discovery: { warnWhenNoEntities: false },
    });
    closers.push(() => orm.close(true));
    return () => orm.em.getConnection().execute("SELECT 13 AS n");
  },
  async prisma() {
    const { PrismaClient } = await import("./generated-js/prisma/client.js");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    closers.push(() => prisma.$disconnect());
    await prisma.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "S2Item" (id serial PRIMARY KEY, name text NOT NULL)',
    );
    return async () => ({
      raw: await prisma.$queryRaw`SELECT 14 AS n`,
      created: (await prisma.s2Item.create({ data: { name: "x" } })).name,
      count: (await prisma.s2Item.findMany({ take: 1 })).length,
    });
  },
};

const queries = {};
for (const name of Object.keys(setups)) {
  if (!wanted.has(name)) continue;
  try {
    queries[name] = await setups[name]();
  } catch (e) {
    errors[name] = `setup ${e?.name}: ${e?.message}`.slice(0, 500);
  }
}
for (const [name, q] of Object.entries(queries)) await probe(name, q);

let scan;
if (process.env.SCAN === "1") {
  scan = instrumentLoadedPgCopies();
  for (const [name, q] of Object.entries(queries))
    await probe(`${name}+scan`, q);
}

for (const close of closers) {
  try {
    await close();
  } catch {}
}

const spans = finishedSpans();
const byRun = {};
for (const [name, r] of Object.entries(runs)) {
  const children = spans.filter((s) => s.parentSpanId === r.spanId);
  byRun[name] = {
    pgSpans: children.length,
    modules: [
      ...new Set(children.map((s) => s.attributes["nestrix.pg.module"])),
    ],
    via: children.map((s) => s.attributes["nestrix.pg.via"]),
    statements: children.map((s) => s.attributes["db.query.text"]),
  };
}
const result = {
  node: process.version,
  execArgv: process.execArgv,
  format: "esm",
  report,
  loadedPgCopies: loadedPgCopies().map(({ file, version }) => ({
    file,
    version,
  })),
  scan,
  byRun,
  errors,
};
process.stdout.write(`__ORM_RESULT__${JSON.stringify(result)}\n`);
