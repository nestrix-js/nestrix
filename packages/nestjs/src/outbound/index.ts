/**
 * Outbound HTTP client spans: `node:http`/`node:https` (P1-08) and `fetch`/undici (P1-09).
 * `installOutbound` subscribes to the diagnostics channels and returns an idempotent unsubscribe.
 * It is called from `NestrixCore` after telemetry is set up, never at import time; the unsubscribe
 * runs on application shutdown.
 *
 * One subscription per process, reference-counted: a second Nestrix application in the same
 * process (two apps open at once in an e2e suite) would otherwise trace every request twice. The
 * first call subscribes with its options; later calls only take a reference (and log once that
 * the first installation's options apply). The channels are unsubscribed when the last reference
 * is released, so closing the first app does not stop tracing for an app still running.
 */
import dc from "node:diagnostics_channel";
import type { Diagnostics } from "../diagnostics.js";
import type { ResolvedOptions } from "../resolve-options.js";
import { subscribeNodeHttp } from "./node-http.js";
import { buildOutboundConfig } from "./rules.js";
import { subscribeUndici, type UndiciSubscriberOptions } from "./undici.js";

type Handler = (message: unknown, name: string | symbol) => void;

interface Installation {
  readonly subscribed: Array<[string, Handler]>;
  readonly diagnostics: Diagnostics;
  references: number;
}

let current: Installation | undefined;

/** Internal options for tests. Not part of the public API. */
export interface InstallOutboundInternals extends UndiciSubscriberOptions {}

function subscribe(
  options: ResolvedOptions,
  diagnostics: Diagnostics,
  internals: InstallOutboundInternals,
): Installation {
  const config = buildOutboundConfig(options, diagnostics);
  const handlers: Array<[string, Handler]> = [
    ...Object.entries(subscribeNodeHttp(config).channels),
    ...Object.entries(subscribeUndici(config, internals).channels),
  ];
  const subscribed: Array<[string, Handler]> = [];
  for (const [name, handler] of handlers) {
    try {
      dc.subscribe(name, handler);
      subscribed.push([name, handler]);
    } catch (error) {
      diagnostics.countFailure("outbound.subscribe", error);
    }
  }
  return { subscribed, diagnostics, references: 0 };
}

function unsubscribe(installation: Installation): void {
  for (const [name, handler] of installation.subscribed) {
    try {
      dc.unsubscribe(name, handler);
    } catch (error) {
      installation.diagnostics.countFailure("outbound.unsubscribe", error);
    }
  }
}

export function installOutbound(
  options: ResolvedOptions,
  diagnostics: Diagnostics,
  internals: InstallOutboundInternals = {},
): () => void {
  try {
    if (current === undefined) {
      current = subscribe(options, diagnostics, internals);
    } else {
      diagnostics.logOnce(
        "outbound.second-instance",
        "Outbound HTTP tracing is already installed by another Nestrix instance in this process; it stays installed while either runs, with the first instance's options.",
      );
    }
    const installation = current;
    installation.references++;
    let released = false;
    return () => {
      try {
        if (released) return;
        released = true;
        installation.references--;
        if (installation.references === 0 && current === installation) {
          current = undefined;
          unsubscribe(installation);
        }
      } catch (error) {
        diagnostics.countFailure("outbound.uninstall", error);
      }
    };
  } catch (error) {
    diagnostics.countFailure("outbound.install", error);
    return () => undefined;
  }
}
