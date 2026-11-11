import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { ServerConfig } from "./config.js";

/** Injection token of the frozen `ServerConfig`: `@Inject(SERVER_CONFIG) config: ServerConfig`. */
export const SERVER_CONFIG = Symbol("nestrix-server:config");

@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class ServerConfigModule {
  static forRoot(config: ServerConfig): DynamicModule {
    return {
      module: ServerConfigModule,
      providers: [{ provide: SERVER_CONFIG, useValue: config }],
      exports: [SERVER_CONFIG],
    };
  }
}
