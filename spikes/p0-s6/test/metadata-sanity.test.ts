// The whole spike lives on decorator metadata. This fails first if Vitest stops emitting it.
import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it } from "vitest";

@Injectable()
class Dep {
  value() {
    return 42;
  }
}

@Injectable()
class Consumer {
  constructor(readonly dep: Dep) {}
}

@Module({ providers: [Dep, Consumer] })
class SanityModule {}

describe("decorator metadata in spike test files", () => {
  it("emits design:paramtypes and Nest injects the dependency", async () => {
    expect(Reflect.getMetadata("design:paramtypes", Consumer)).toEqual([Dep]);
    const app = await NestFactory.createApplicationContext(SanityModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      expect(app.get(Consumer).dep.value()).toBe(42);
    } finally {
      await app.close();
    }
  });
});
