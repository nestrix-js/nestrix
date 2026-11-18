/**
 * The `new_error_group` rule kind (issue #26, D-103): a notification for each error group seen for
 * the first time and for each regression of a resolved group, from the stored groups
 * (`errors/sync.ts`) rather than from a metric and a threshold.
 *
 * Once per group and episode: the claim is an insert into `error_group_alerts`, whose primary key
 * is (rule, service, group, episode). Episode 0 is the group's first appearance and episode N its
 * Nth regression (`error_groups.regressions`). The claim, the `alert_events` row and the state
 * write are one transaction (the evaluator's, under its advisory lock), and the key makes a second
 * claim impossible even if two instances ever evaluated at once, or the process restarted between
 * the claim and the delivery: the notification is then lost, never doubled (the evaluator's
 * at-most-once rule).
 *
 * What is notified:
 * - new: the group is `open`, was stored after the rule was created (database clock on both
 *   sides) and was first seen within the last 24 hours. A group resolved or ignored before the
 *   evaluator got to it is skipped.
 * - regressed: the group is `regressed` now, the regression was detected after the rule's
 *   creation and happened within the last 24 hours. An `ignored` group never notifies; un-ignoring it does not replay the past.
 * - Rule filters: `service` and `route`, both optional and exact.
 * - At most `PER_RUN` notifications per rule and run; the rest follow on the next runs.
 */
import type { AlertErrorGroup } from "@nestrix-js/protocol";
import type { PoolClient } from "pg";
import type { AlertRuleRow } from "./store.js";

const PER_RUN = 50;
const MAX_AGE_MS = 24 * 3_600_000;

export interface ClaimedGroup {
  eventId: number;
  group: AlertErrorGroup;
  /** When the condition began: the first occurrence, or the regressing one. */
  startedAtMs: number;
}

interface ClaimRow {
  episode: number;
  at: Date;
  service_name: string;
  key_hash: string;
  group_key: string;
  error_type: string | null;
  pattern: string;
  route: string | null;
  last_release: string | null;
  resolved_in_release: string | null;
  first_seen: Date;
  last_seen: Date;
}

const FILTERS = `($3::text IS NULL OR g.service_name = $3) AND ($4::text IS NULL OR g.route = $4)`;
const UNCLAIMED = (episode: string) => `NOT EXISTS (
  SELECT 1 FROM error_group_alerts a
   WHERE a.rule_id = $5 AND a.service_name = g.service_name
     AND a.key_hash = g.key_hash AND a.episode = ${episode})`;

/** Claims the groups `rule` has not notified yet, and records one event for each. */
export async function claimErrorGroups(
  client: PoolClient,
  rule: AlertRuleRow,
  nowMs: number,
): Promise<ClaimedGroup[]> {
  const claimed = await client.query<ClaimRow>(
    `WITH due AS (
       SELECT g.service_name, g.key_hash, 0 AS episode, g.first_seen AS at
         FROM error_groups g
        WHERE g.state = 'open' AND g.created_at >= $1 AND g.first_seen > $2
          AND ${FILTERS} AND ${UNCLAIMED("0")}
       UNION ALL
       SELECT g.service_name, g.key_hash, g.regressions, g.regressed_at
         FROM error_groups g
        WHERE g.state = 'regressed' AND g.regressed_detected_at >= $1 AND g.regressed_at > $2
          AND ${FILTERS} AND ${UNCLAIMED("g.regressions")}
     ), picked AS (
       SELECT * FROM due ORDER BY at LIMIT $6
     ), claimed AS (
       INSERT INTO error_group_alerts (rule_id, service_name, key_hash, episode)
       SELECT $5, service_name, key_hash, episode FROM picked
       ON CONFLICT DO NOTHING
       RETURNING service_name, key_hash, episode
     )
     SELECT c.episode, p.at, g.service_name, g.key_hash, g.group_key, g.error_type, g.pattern, g.route,
            g.last_release, g.resolved_in_release, g.first_seen, g.last_seen
       FROM claimed c
       JOIN picked p USING (service_name, key_hash, episode)
       JOIN error_groups g USING (service_name, key_hash)
      ORDER BY p.at`,
    [
      rule.created_at,
      new Date(nowMs - MAX_AGE_MS),
      rule.service_name,
      rule.route,
      rule.id,
      PER_RUN,
    ],
  );
  const out: ClaimedGroup[] = [];
  for (const r of claimed.rows) {
    const ev = await client.query<{ id: string }>(
      `INSERT INTO alert_events (rule_id, created_at, kind, value, threshold)
       VALUES ($1, $2, 'firing', NULL, $3) RETURNING id`,
      [rule.id, new Date(nowMs), rule.threshold],
    );
    const eventId = Number(ev.rows[0]?.id);
    await client.query(
      `UPDATE error_group_alerts SET event_id = $5
        WHERE rule_id = $1 AND service_name = $2 AND key_hash = $3 AND episode = $4`,
      [rule.id, r.service_name, r.key_hash, r.episode, eventId],
    );
    out.push({
      eventId,
      startedAtMs: r.at.getTime(),
      group: {
        reason: r.episode === 0 ? "new" : "regressed",
        key: r.group_key,
        service: r.service_name,
        errorType: r.error_type,
        pattern: r.pattern,
        route: r.route,
        release: r.last_release,
        resolvedInRelease: r.resolved_in_release,
        firstSeen: r.first_seen.toISOString(),
        lastSeen: r.last_seen.toISOString(),
      },
    });
  }
  return out;
}
