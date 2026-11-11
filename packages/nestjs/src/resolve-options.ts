import type {
  NestrixModuleOptions,
  NestrixQueueOptions,
  RedactHook,
  UrlMatcher,
} from "./options.js";

/** An OTLP/HTTP destination: `url` is the full traces URL, `/v1/traces` already applied. */
export interface ResolvedOtlp {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMillis: number;
}

/** Every option with its default applied. Deeply frozen. */
export interface ResolvedOptions {
  /** `false` only when `NestrixModule.forRootAsync`'s factory returned `enabled: false`. */
  readonly enabled: boolean;
  readonly serviceName: string | undefined;
  readonly resourceAttributes: Readonly<
    Record<string, string | number | boolean>
  >;
  readonly sampleRate: number;
  readonly export: {
    /** `false` when export is off: `otlp: false`, or no endpoint by option or environment. */
    readonly otlp: ResolvedOtlp | false;
    readonly queue: {
      readonly maxQueueSize: number;
      readonly maxExportBatchSize: number;
      readonly scheduledDelayMillis: number;
    };
  };
  readonly ignore: {
    readonly routes: readonly UrlMatcher[];
    readonly outgoing: readonly UrlMatcher[];
  };
  readonly http: {
    readonly requestHeaders: readonly string[];
    readonly responseHeaders: readonly string[];
    readonly redactQueryKeys: readonly string[];
  };
  readonly redact: RedactHook | undefined;
  /** Raw `OTEL_RESOURCE_ATTRIBUTES`; parsed by the telemetry setup (SDK 3 does not read it). */
  readonly otelResourceAttributes: string | undefined;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_QUEUE: Required<NestrixQueueOptions> = {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 5000,
};
const DEFAULT_TIMEOUT_MILLIS = 10_000;
const TRACES_PATH = "/v1/traces";

/** Whether `NESTRIX_ENABLED` switches Nestrix off. `false` and `0`, any case, do. */
export function isDisabledByEnv(env: Environment): boolean {
  const value = env.NESTRIX_ENABLED?.trim().toLowerCase();
  return value === "false" || value === "0";
}

function invalid(message: string): never {
  throw new Error(`Invalid Nestrix options: ${message}`);
}

function blank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function checkPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    invalid(`${name} must be a positive integer, got ${String(value)}`);
  }
}

/** `key=value,key2=value2`, values percent-decoded, as `OTEL_EXPORTER_OTLP_HEADERS`. Bad pairs are skipped. */
function parseHeaderList(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const pair of value.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    if (!key) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function withTracesPath(base: string): string {
  return `${base.replace(/\/+$/, "")}${TRACES_PATH}`;
}

function resolveOtlp(
  options: NestrixModuleOptions,
  env: Environment,
): ResolvedOtlp | false {
  const otlp = options.export?.otlp;
  if (otlp === false) return false;

  const optionEndpoint = blank(otlp?.endpoint);
  const tracesEnv = blank(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const genericEnv = blank(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  let url: string;
  if (optionEndpoint) url = withTracesPath(optionEndpoint);
  else if (tracesEnv) url = tracesEnv;
  else if (genericEnv) url = withTracesPath(genericEnv);
  else return false;

  const timeoutMillis = otlp?.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS;
  checkPositiveInteger("export.otlp.timeoutMillis", timeoutMillis);

  // Signal-specific variable wins over the generic one, key by key; options win over both.
  const headers = {
    ...parseHeaderList(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseHeaderList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    ...otlp?.headers,
  };
  return Object.freeze({
    url,
    headers: Object.freeze(headers),
    timeoutMillis,
  });
}

/**
 * Pure: options and an environment object in, fully defaulted and frozen options out.
 * Throws on invalid options; that is a startup error, not a request-path failure.
 * `NESTRIX_ENABLED=false` in `env` overrides `enabled: true` (a kill switch).
 */
export function resolveOptions(
  options: NestrixModuleOptions | undefined,
  env: Environment,
): ResolvedOptions {
  const o = options ?? {};

  const sampleRate = o.sampleRate ?? 1;
  if (
    typeof sampleRate !== "number" ||
    Number.isNaN(sampleRate) ||
    sampleRate < 0 ||
    sampleRate > 1
  ) {
    invalid(`sampleRate must be between 0 and 1, got ${String(sampleRate)}`);
  }

  const queue = { ...DEFAULT_QUEUE, ...o.export?.queue };
  checkPositiveInteger("export.queue.maxQueueSize", queue.maxQueueSize);
  checkPositiveInteger(
    "export.queue.maxExportBatchSize",
    queue.maxExportBatchSize,
  );
  checkPositiveInteger(
    "export.queue.scheduledDelayMillis",
    queue.scheduledDelayMillis,
  );
  if (queue.maxExportBatchSize > queue.maxQueueSize) {
    invalid(
      `export.queue.maxExportBatchSize (${queue.maxExportBatchSize}) must not exceed export.queue.maxQueueSize (${queue.maxQueueSize})`,
    );
  }

  const enabled = o.enabled !== false && !isDisabledByEnv(env);

  const resolved: ResolvedOptions = {
    enabled,
    serviceName: blank(o.serviceName) ?? blank(env.OTEL_SERVICE_NAME),
    resourceAttributes: Object.freeze({ ...o.resourceAttributes }),
    sampleRate,
    export: Object.freeze({
      otlp: resolveOtlp(o, env),
      queue: Object.freeze(queue),
    }),
    ignore: Object.freeze({
      routes: Object.freeze([...(o.ignore?.routes ?? [])]),
      outgoing: Object.freeze([...(o.ignore?.outgoing ?? [])]),
    }),
    http: Object.freeze({
      requestHeaders: Object.freeze([...(o.http?.requestHeaders ?? [])]),
      responseHeaders: Object.freeze([...(o.http?.responseHeaders ?? [])]),
      redactQueryKeys: Object.freeze([...(o.http?.redactQueryKeys ?? [])]),
    }),
    redact: o.redact,
    otelResourceAttributes: blank(env.OTEL_RESOURCE_ATTRIBUTES),
  };
  return Object.freeze(resolved);
}
