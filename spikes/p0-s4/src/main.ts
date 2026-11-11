// CommonJS Nest 12 app (TS compiled to CJS). Q1 (loads without flags or warnings)
// and Q2 (one reflect-metadata, design:paramtypes present).
import "reflect-metadata";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestrixModule } from "@nestrix-js/nestjs";
import { EsmDep, EsmProbe, reflectInfoFromEsm } from "../dist-esm/probe.mjs";

process.on("warning", (w) => {
  console.log(`[warning event] ${w.name}: ${w.message}`);
});

@Injectable()
class LocalDep {}

@Injectable()
class LocalService {
  constructor(readonly dep: LocalDep) {}
}

@Controller()
class AppController {
  constructor(
    private readonly local: LocalService,
    private readonly probe: EsmProbe,
  ) {}

  @Get("hello")
  hello() {
    return {
      localDepInjected: this.local.dep instanceof LocalDep,
      esmDepInjected: this.probe.dep instanceof EsmDep,
      esmDep: this.probe.dep.hello(),
    };
  }
}

@Module({
  controllers: [AppController],
  providers: [LocalDep, LocalService, EsmDep, EsmProbe],
})
class AppModule {}

async function main() {
  console.log(`node ${process.version}`);
  console.log(
    `require("@nestrix-js/nestjs") -> typeof NestrixModule.forRoot = ${typeof NestrixModule.forRoot}`,
  );

  // Q2: one copy of reflect-metadata?
  const appResolved = require.resolve("reflect-metadata");
  const esm = reflectInfoFromEsm();
  const copies = Object.keys(require.cache).filter((k) =>
    /[\\/]reflect-metadata[\\/]/.test(k),
  );
  console.log("reflect-metadata resolved from CJS app :", appResolved);
  console.log("reflect-metadata resolved from ESM file:", esm.resolved);
  console.log(
    "same resolved path                     :",
    appResolved === esm.resolved,
  );
  console.log(
    "same Reflect.getMetadata function      :",
    esm.getMetadata === Reflect.getMetadata,
  );
  console.log(
    "reflect-metadata entries in require.cache:",
    copies.length,
    copies,
  );
  console.log(
    "design:paramtypes (CJS class LocalService):",
    (
      Reflect.getMetadata("design:paramtypes", LocalService) as {
        name: string;
      }[]
    ).map((t) => t.name),
  );
  console.log(
    "design:paramtypes (ESM class EsmProbe)    :",
    esm.paramtypes.map((t) => (t as { name: string }).name),
  );

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const url = await app.getUrl();
  const res = await fetch(`${url}/hello`);
  console.log("GET /hello ->", res.status, JSON.stringify(await res.json()));
  await app.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
