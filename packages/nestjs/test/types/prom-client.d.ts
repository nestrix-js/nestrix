// prom-client is not a dependency of this repository. This declares only what the README's
// `export-failure-counter` sample uses, so `pnpm typecheck` still compiles that sample.
declare module "prom-client" {
  export class Counter<L extends string = string> {
    constructor(config: {
      name: string;
      help: string;
      labelNames?: readonly L[];
    });
    inc(labels?: Partial<Record<L, string>>, value?: number): void;
  }
}
