// Stands in for decorated code that lives inside @nestrix-js/nestjs: an ES module
// (.mts, always ESM) that a CommonJS app loads with require(). Throwaway; the real
// package has no decorated classes yet.
import "reflect-metadata";
import { createRequire } from "node:module";
import { Injectable } from "@nestjs/common";

@Injectable()
export class EsmDep {
  hello(): string {
    return "esm-dep";
  }
}

@Injectable()
export class EsmProbe {
  constructor(readonly dep: EsmDep) {}
}

/** What the ESM side sees: where it resolves reflect-metadata, and its Reflect API. */
export function reflectInfoFromEsm() {
  const req = createRequire(import.meta.url);
  return {
    resolved: req.resolve("reflect-metadata"),
    getMetadata: Reflect.getMetadata,
    paramtypes: Reflect.getMetadata("design:paramtypes", EsmProbe) as unknown[],
  };
}
