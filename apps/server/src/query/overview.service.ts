/**
 * `GET /api/v1/overview` (phase 11, P11-01): gathers the inputs of the shared computation
 * (`overview-compute.ts`) from the rollup tables (route minutes, counted from the stored spans),
 * the stored traces and spans (status mix, time by kind, releases), the error groups and
 * dependencies queries, and the SLO statuses. Same shape as the embedded dashboard's.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { OverviewResponse, OverviewStatusMix } from "@nestrix-js/protocol";
import type pg from "pg";
import { SlosService } from "../slos/slos.service.js";
import { STORAGE_POOL } from "../storage/storage.module.js";
import {
  computeOverview,
  type KindRow,
  type MinuteRow,
  type SloBurnInput,
} from "./overview-compute.js";
import { QueryService } from "./query.service.js";

const MINUTE_MS = 60_000;
/** Clock skew allowed between a span and a child on another host. */
const SKEW_MS = MINUTE_MS;

/** Placeholders for one statement: `add` returns `$n` for the value. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

interface KindSqlRow {
  kind: string;
  db_system: string | null;
  messaging: boolean;
  http: boolean;
  nest: boolean;
  own_ms: number | string;
}

@Injectable()
export class OverviewService {
  constructor(
    @Inject(STORAGE_POOL) private readonly pool: pg.Pool,
    private readonly query: QueryService,
    private readonly slos: SlosService,
  ) {}

  private async rows<T>(
    text: string,
    params: readonly unknown[],
  ): Promise<T[]> {
    const result = await this.pool.query(text, params as unknown[]);
    return result.rows as T[];
  }

  async overview(
    windowMinutes: number,
    apdexMs: number,
    service: string | undefined,
    now: number = Date.now(),
  ): Promise<OverviewResponse> {
    const last = Math.floor(now / MINUTE_MS);
    const curFirst = last - windowMinutes + 1;
    const prevFirst = curFirst - windowMinutes;
    const curFromMs = curFirst * MINUTE_MS;
    const prevFromMs = prevFirst * MINUTE_MS;

    const [
      minuteRows,
      since,
      status,
      kinds,
      previousKinds,
      releases,
      errorGroups,
      previousErrorGroups,
      dependencies,
      previousDependencies,
      slos,
    ] = await Promise.all([
      this.routeMinutes(prevFromMs, last * MINUTE_MS, service),
      this.statisticsSince(service),
      this.statusMix(curFromMs, now, service),
      this.kindRows(curFromMs, now, service),
      this.kindRows(prevFromMs, curFromMs - 1, service),
      this.newReleases(curFromMs, now, service),
      this.query.errorGroups(windowMinutes, service, now),
      this.query.errorGroups(windowMinutes, service, curFromMs - 1),
      this.query.dependencies(windowMinutes, service, now),
      this.query.dependencies(windowMinutes, service, curFromMs - 1),
      this.sloBurns(service),
    ]);

    const previousCovered = since !== undefined && since <= prevFromMs;
    return computeOverview({
      nowUnixMs: now,
      windowMinutes,
      apdexMs,
      previousCovered,
      note: previousCovered
        ? null
        : "Statistics start less than two windows ago, so the previous window is only partly counted or empty.",
      rows: minuteRows,
      status,
      kinds,
      previousKinds: previousKinds.length === 0 ? null : previousKinds,
      releases,
      errorGroups: {
        current: errorGroups.groups,
        previous: previousErrorGroups.groups,
      },
      dependencies: {
        current: dependencies.dependencies,
        previous: previousDependencies.dependencies,
      },
      slos,
    });
  }

  private async routeMinutes(
    fromMs: number,
    toMs: number,
    service: string | undefined,
  ): Promise<MinuteRow[]> {
    const p = new Params();
    const where = [
      `minute >= ${p.add(new Date(fromMs))}`,
      `minute <= ${p.add(new Date(toMs))}`,
    ];
    if (service !== undefined) where.push(`service_name = ${p.add(service)}`);
    const rows = await this.rows<{
      minute_ms: string;
      method: string;
      route: string;
      count: number;
      errors: number;
      max_ms: number;
      hist: number[];
    }>(
      `SELECT (extract(epoch FROM minute) * 1000)::bigint AS minute_ms, method, route, count, errors, max_ms, hist
         FROM route_minutes WHERE ${where.join(" AND ")}`,
      p.values,
    );
    return rows.map((r) => ({
      minute: Math.floor(Number(r.minute_ms) / MINUTE_MS),
      method: r.method,
      route: r.route,
      count: Number(r.count),
      errors: Number(r.errors),
      max: Number(r.max_ms),
      hist: r.hist,
    }));
  }

  /** The first minute with statistics (of the service), Unix ms. */
  private async statisticsSince(
    service: string | undefined,
  ): Promise<number | undefined> {
    const p = new Params();
    const where =
      service === undefined ? "" : `WHERE service_name = ${p.add(service)}`;
    const [row] = await this.rows<{ since: string | null }>(
      `SELECT (extract(epoch FROM min(minute)) * 1000)::bigint AS since FROM route_minutes ${where}`,
      p.values,
    );
    return row?.since == null ? undefined : Number(row.since);
  }

  /** Root outcomes of the traces that started in the window. */
  private async statusMix(
    fromMs: number,
    toMs: number,
    service: string | undefined,
  ): Promise<OverviewStatusMix> {
    const p = new Params();
    const where = [
      `start_time >= ${p.add(new Date(fromMs))}`,
      `start_time <= ${p.add(new Date(toMs))}`,
    ];
    if (service !== undefined) where.push(`service_name = ${p.add(service)}`);
    const [row] = await this.rows<{
      total: string;
      server_error: string;
      client_error: string;
      redirect: string;
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE is_error OR http_status >= 500) AS server_error,
              count(*) FILTER (WHERE NOT is_error AND http_status BETWEEN 400 AND 499) AS client_error,
              count(*) FILTER (WHERE NOT is_error AND http_status BETWEEN 300 AND 399) AS redirect
         FROM traces WHERE ${where.join(" AND ")}`,
      p.values,
    );
    const total = Number(row?.total ?? 0);
    const serverError = Number(row?.server_error ?? 0);
    const clientError = Number(row?.client_error ?? 0);
    const redirect = Number(row?.redirect ?? 0);
    return {
      ok: Math.max(0, total - serverError - clientError - redirect),
      redirect,
      clientError,
      serverError,
    };
  }

  /** Own time (duration minus the children's) of spans started in the range, by what decides their kind. */
  private async kindRows(
    fromMs: number,
    toMs: number,
    service: string | undefined,
  ): Promise<KindRow[]> {
    const p = new Params();
    const where = [
      `s.start_time >= ${p.add(new Date(fromMs))}`,
      `s.start_time <= ${p.add(new Date(toMs))}`,
    ];
    if (service !== undefined) where.push(`s.service_name = ${p.add(service)}`);
    // One pass: the window's spans once, their children summed once per parent. A child may start
    // a little before its parent (another host's clock), so children are bounded by the window's
    // start less a minute of skew, which still lets Postgres skip older partitions.
    const skewFrom = p.add(new Date(fromMs - SKEW_MS));
    const rows = await this.rows<KindSqlRow>(
      `WITH win AS (
         SELECT s.trace_id, s.span_id, s.kind, s.attributes, s.class_name, s.duration_ns
           FROM spans s
          WHERE ${where.join(" AND ")}
       ), kids AS (
         SELECT c.trace_id, c.parent_span_id, sum(c.duration_ns) AS child_ns
           FROM spans c
          WHERE c.trace_id IN (SELECT trace_id FROM win)
            AND c.parent_span_id IS NOT NULL
            AND c.start_time >= ${skewFrom}
          GROUP BY c.trace_id, c.parent_span_id
       )
       SELECT s.kind,
              lower(coalesce(s.attributes->>'db.system.name', s.attributes->>'db.system')) AS db_system,
              (s.attributes ? 'messaging.system') AS messaging,
              (s.attributes ?| array['http.request.method', 'http.method', 'url.full']) AS http,
              (s.class_name IS NOT NULL OR s.attributes ? 'nestrix.component') AS nest,
              (sum(greatest(0, s.duration_ns - coalesce(ch.child_ns, 0)))::float8 / 1e6) AS own_ms
         FROM win s
         LEFT JOIN kids ch ON ch.trace_id = s.trace_id AND ch.parent_span_id = s.span_id
        GROUP BY 1, 2, 3, 4, 5`,
      p.values,
    );
    return rows.map((r) => ({
      facts: {
        kind: r.kind,
        dbSystem:
          r.db_system === null || r.db_system === "" ? undefined : r.db_system,
        messaging: r.messaging,
        http: r.http,
        nest: r.nest,
      },
      ms: Number(r.own_ms),
    }));
  }

  /** Releases whose first stored trace started in the window. */
  private async newReleases(
    fromMs: number,
    toMs: number,
    service: string | undefined,
  ): Promise<{ version: string; firstSeenUnixMs: number }[]> {
    const p = new Params();
    const from = p.add(new Date(fromMs));
    const to = p.add(new Date(toMs));
    const serviceFilter =
      service === undefined ? "" : `AND service_name = ${p.add(service)}`;
    const rows = await this.rows<{ release: string; first_ms: string }>(
      `SELECT release, (extract(epoch FROM min(start_time)) * 1000)::bigint AS first_ms
         FROM traces
        WHERE release IN (SELECT DISTINCT release FROM traces
                           WHERE release IS NOT NULL AND start_time >= ${from} AND start_time <= ${to} ${serviceFilter})
          ${serviceFilter}
        GROUP BY release
       HAVING min(start_time) >= ${from}
        ORDER BY min(start_time)`,
      p.values,
    );
    return rows.map((r) => ({
      version: r.release,
      firstSeenUnixMs: Number(r.first_ms),
    }));
  }

  /** SLOs (of the service, when given) with their one-hour burn rate. Never fails the overview. */
  private async sloBurns(service: string | undefined): Promise<SloBurnInput[]> {
    try {
      const all = await this.slos.list();
      return all
        .filter((s) => service === undefined || s.service === service)
        .map((s) => ({
          id: s.id,
          name: s.name,
          burnRate1h: s.status.burnRate["1h"],
          badRequests: s.status.badRequests,
        }));
    } catch {
      return [];
    }
  }
}
