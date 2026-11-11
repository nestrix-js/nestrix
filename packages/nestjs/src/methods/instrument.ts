// The public `instrument` objects for `NestFactory.create(AppModule, { instrument })`.
import { diagnostics } from "../diagnostics.js";
import { nestrixInstanceDecorator } from "./registry.js";

/** The shape Nest's `instrument` option takes (`NestApplicationContextOptions.instrument`). */
export interface NestInstrument {
  instanceDecorator: (instance: unknown) => unknown;
}

/**
 * Level 2 method spans: `NestFactory.create(AppModule, { instrument: NestrixInstrument })`. What is
 * traced is set by `NestrixModule.forRoot({ methods })`. Not applied under `@nestjs/testing` (D-48).
 */
export const NestrixInstrument: Readonly<NestInstrument> = Object.freeze({
  instanceDecorator: nestrixInstanceDecorator,
});

/**
 * Combines several `instrument` objects into one, for when another tool also takes Nest's
 * `instrument` option. Each `instanceDecorator` runs in the order given and receives what the
 * previous one returned. One that throws (or is missing) passes the instance on unchanged, and the
 * failure is counted.
 */
export function composeInstrument(
  ...instruments: ReadonlyArray<NestInstrument | null | undefined>
): NestInstrument {
  const list = [...instruments];
  return {
    instanceDecorator(instance: unknown): unknown {
      let current = instance;
      for (const instrument of list) {
        try {
          const decorate = instrument?.instanceDecorator;
          if (typeof decorate === "function") {
            current = Reflect.apply(decorate, instrument, [current]);
          }
        } catch (error) {
          diagnostics.countFailure("methods.compose", error);
        }
      }
      return current;
    },
  };
}
