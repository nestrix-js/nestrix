import type { ClassMatcher, NestrixEnhancerKind } from "../options.js";

/** `methods` options with defaults applied (`resolveMethods` in `resolve-options.ts`). Frozen. */
export interface ResolvedMethods {
  readonly enabled: boolean;
  readonly include: readonly ClassMatcher[];
  readonly exclude: readonly ClassMatcher[];
  readonly enhancers: readonly NestrixEnhancerKind[];
}

export const DEFAULT_METHODS: ResolvedMethods = Object.freeze({
  enabled: true,
  include: Object.freeze([]) as readonly ClassMatcher[],
  exclude: Object.freeze([]) as readonly ClassMatcher[],
  enhancers: Object.freeze([]) as readonly NestrixEnhancerKind[],
});

/** `methods: false`. */
export const DISABLED_METHODS: ResolvedMethods = Object.freeze({
  enabled: false,
  include: Object.freeze([]) as readonly ClassMatcher[],
  exclude: Object.freeze([]) as readonly ClassMatcher[],
  enhancers: Object.freeze([]) as readonly NestrixEnhancerKind[],
});
