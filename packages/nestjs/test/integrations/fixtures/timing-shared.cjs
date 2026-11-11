// Shared body of the D-50 timing fixture apps (timing-app.mjs, timing-app.cjs). Each entry loads
// Nest, Nestrix, the SDK and the stand-in ORM its own way (ESM `import` or CJS `require`) and
// passes them in, so this file only builds the app with Nest's decorators called as functions.
//
// One run: register a host SDK (in-memory exporter, ALS context manager, W3C), build an Express
// Nest app whose root module imports NestrixModule.forRoot({ ui: false }), with GET /q running one
// query through the stand-in ORM's nested `pg` copy. The ORM is loaded
//   eager:        before the app module is defined (import time),
//   factory:      in a provider factory (`useFactory`) of the root module,
//   late-factory: in a provider factory of a module imported after NestrixModule,
//   async-factory: in a root-module factory that first awaits 20 ms (stands in for I/O, such as
//                 connecting, before the ORM's driver is imported),
//   request:      in the handler, on the first request.
// Prints one JSON line: where the nested copy is, whether it ended up wrapped, the pg
// integration's status (each wrapped module with the scan that found it), and the db spans.
"use strict";

const WRAPPED = Symbol.for("nestrix.pg.wrapped");

async function run(deps) {
  const {
    common,
    core,
    platform,
    nestrix,
    api,
    sdk,
    contextManager,
    otelCore,
    pgStatus,
    loadOrm,
    eagerOrm,
    mode,
    pgConfig,
  } = deps;

  const exporter = new sdk.InMemorySpanExporter();
  const provider = new sdk.TracerProvider({
    spanProcessors: [new sdk.SimpleSpanProcessor({ exporter })],
  });
  api.trace.setGlobalTracerProvider(provider);
  api.context.setGlobalContextManager(
    new contextManager.AsyncLocalStorageContextManager().enable(),
  );
  api.propagation.setGlobalPropagator(new otelCore.W3CTraceContextPropagator());

  const ORM = "ORM";
  const pools = new Map();
  const poolFor = (orm) => {
    const createPool = orm.createPool ?? orm.default?.createPool;
    if (!pools.has(orm)) pools.set(orm, createPool(pgConfig));
    return pools.get(orm);
  };
  let loadedOrm;

  class AppController {
    constructor(orm) {
      this.orm = orm;
    }
    async q() {
      const orm = this.orm ?? (await loadOrm());
      loadedOrm = orm;
      const result = await poolFor(orm).query("SELECT 1 AS n");
      return { n: result.rows[0].n };
    }
  }
  common.Controller()(AppController);
  common.Get("q")(
    AppController.prototype,
    "q",
    Object.getOwnPropertyDescriptor(AppController.prototype, "q"),
  );
  common.Inject(ORM)(AppController, undefined, 0);

  const factory = { provide: ORM, useFactory: () => loadOrm() };
  // late-factory: the factory lives in a module imported after NestrixModule.
  class OrmModule {}
  common.Module({ providers: [factory], exports: [ORM] })(OrmModule);
  const asyncFactory = {
    provide: ORM,
    useFactory: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return loadOrm();
    },
  };
  const ormProvider =
    mode === "factory"
      ? factory
      : mode === "async-factory"
        ? asyncFactory
        : { provide: ORM, useValue: mode === "eager" ? eagerOrm : null };

  class AppModule {}
  common.Module({
    imports: [
      nestrix.NestrixModule.forRoot({ ui: false }),
      ...(mode === "late-factory" ? [OrmModule] : []),
    ],
    controllers: [AppController],
    providers: mode === "late-factory" ? [] : [ormProvider],
  })(AppModule);

  const app = await core.NestFactory.create(
    AppModule,
    new platform.ExpressAdapter(),
    { logger: false },
  );
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address();
  const bodies = [];
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/q`);
    bodies.push(await res.json());
  }
  // The server span ends on the response's `close`; give it a moment.
  for (let i = 0; i < 50; i++) {
    if (
      exporter.getFinishedSpans().filter((s) => s.kind === api.SpanKind.SERVER)
        .length >= 2
    )
      break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const spans = exporter.getFinishedSpans();
  const servers = new Set(
    spans
      .filter((s) => s.kind === api.SpanKind.SERVER)
      .map((s) => s.spanContext().spanId),
  );
  const orm = loadedOrm;
  const nestedPg = orm.pg ?? orm.default?.pg;
  const result = {
    nestedPath: orm.pgPath ?? orm.default?.pgPath,
    nestedWrapped:
      typeof nestedPg.Client.prototype.query[WRAPPED] === "function",
    status: pgStatus(),
    bodies,
    dbSpans: spans
      .filter((s) => s.attributes["db.system.name"] !== undefined)
      .map((s) => ({
        name: s.name,
        underServerSpan: servers.has(s.parentSpanContext?.spanId),
      })),
  };
  await app.close();
  for (const pool of pools.values()) await pool.end();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { run };
