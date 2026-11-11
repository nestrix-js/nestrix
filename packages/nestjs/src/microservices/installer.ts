/**
 * Wires microservice tracing into an application (backlog P4-01):
 * - while an enabled Nestrix application runs, the server-side hooks and client wrappers are
 *   active (`activateMicroservices`); they pass straight through otherwise;
 * - at `onModuleInit`, every static provider that is a `ClientProxy` (what `ClientsModule`
 *   registers) is instrumented with `instrumentClient`. All static providers exist by then; a
 *   client used before Nestrix's `onModuleInit` runs is not traced for those calls.
 *
 * Providers are found through `ModulesContainer` (public, `@nestjs/core`), reading only public
 * members: `Module.providers` and `InstanceWrapper.isDependencyTreeStatic()` / `instance`.
 * Request-scoped and transient clients are left alone; `instrumentClient` covers them.
 *
 * Nothing here imports `@nestjs/microservices`. Constructor and hooks never throw.
 */
import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { diagnostics } from "../diagnostics.js";
import type { ResolvedOptions } from "../resolve-options.js";
import { NESTRIX_OPTIONS } from "../tokens.js";
import { instrumentClient, looksLikeClient } from "./client.js";
import { activateMicroservices, fault } from "./shared.js";

interface WrapperLike {
  isDependencyTreeStatic?: () => boolean;
  instance?: unknown;
}

/** Every static provider instance of every module that looks like a microservice client. */
export function findClients(modules: Iterable<unknown>): object[] {
  const found = new Set<object>();
  for (const module of modules) {
    let providers: unknown;
    try {
      providers = (module as { providers?: unknown }).providers;
    } catch {
      continue;
    }
    if (!(providers instanceof Map)) continue;
    for (const wrapper of (providers as Map<unknown, WrapperLike>).values()) {
      try {
        if (wrapper?.isDependencyTreeStatic?.() !== true) continue;
        const instance = wrapper.instance;
        if (looksLikeClient(instance)) found.add(instance);
      } catch {
        // A provider whose wrapper cannot be read is skipped.
      }
    }
  }
  return [...found];
}

@Injectable()
export class NestrixMicroservices
  implements OnModuleInit, OnApplicationShutdown
{
  private release: (() => void) | undefined;
  private readonly modules: ModulesContainer | undefined;

  constructor(
    @Inject(NESTRIX_OPTIONS) options: ResolvedOptions,
    @Optional() @Inject(ModulesContainer) modules?: ModulesContainer,
  ) {
    this.modules = modules;
    try {
      if (options.enabled) this.release = activateMicroservices();
    } catch (error) {
      diagnostics.countFailure("microservices.install", error);
    }
  }

  onModuleInit(): void {
    try {
      fault("installer.module-init");
      if (this.release === undefined || this.modules === undefined) return;
      for (const client of findClients(this.modules.values())) {
        instrumentClient(client);
      }
    } catch (error) {
      diagnostics.countFailure("microservices.install", error);
    }
  }

  onApplicationShutdown(): void {
    try {
      this.release?.();
      this.release = undefined;
    } catch (error) {
      diagnostics.countFailure("microservices.shutdown", error);
    }
  }
}
