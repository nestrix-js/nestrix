/** Injection token for the fully resolved options (`ResolvedOptions`). Internal until the lead exports it. */
export const NESTRIX_OPTIONS = Symbol.for("@nestrix-js/nestjs:options");

/** Internal: the lazily loaded runtime (`runtime.ts`), resolved by an async factory (D-99). */
export const NESTRIX_RUNTIME = Symbol.for("@nestrix-js/nestjs:runtime");
