import type {
  AlertEvent,
  AlertRule,
  AlertRuleCreateResponse,
  Slo,
} from "@nestrix-js/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import {
  Chip,
  EmptyState,
  ErrorState,
  KpiStrip,
  PageHeader,
  PageNote,
  SkeletonKpiStrip,
  SkeletonList,
  StatTile,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createAlert,
  deleteAlert,
  getAlertEvents,
  getAlerts,
  getMeta,
  getSlos,
  testAlert,
  updateAlert,
} from "@/lib/api";
import { useCanAdmin } from "@/lib/can-admin";
import { formatRelative } from "@/lib/format";
import { pollInterval, usePaused } from "@/lib/live";
import { useNow } from "@/lib/use-now";
import {
  type AlertForm,
  conditionText,
  deliveryTone,
  describeDelivery,
  emptyForm,
  formatMetricValue,
  formFromRule,
  isKnownMetric,
  METRIC_LABEL,
  ruleState,
  summarizeRules,
  toRequest,
  webhookOrigin,
} from "@/views/alerts/alerts-format";

const selectClass =
  "h-8 w-full rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const THRESHOLD_UNIT: Record<string, string> = {
  error_rate: "Threshold (% of requests that fail)",
  p95_ms: "Threshold (p95 in ms)",
  slo_burn_rate: "Threshold (burn-rate multiple)",
};

/** The signing secret of a new rule, shown once (the server never returns it again). */
function NewSecret({
  created,
  onDone,
}: {
  created: AlertRuleCreateResponse;
  onDone: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"yes" | "manual" | null>(null);
  const copy = async () => {
    field.current?.select();
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied("yes");
    } catch {
      setCopied("manual");
    }
  };
  return (
    <div
      data-testid="new-secret"
      role="status"
      className="space-y-3 rounded-lg border border-warning/60 bg-warning/10 p-4"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-[var(--warning-text)]"
          aria-hidden
        />
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            Rule "{created.rule.name}" created. Copy its signing secret now: it
            is not shown again.
          </p>
          <p className="text-xs text-muted-foreground">
            The receiver needs it to verify the <code>x-nestrix-signature</code>{" "}
            header of each notification.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          ref={field}
          readOnly
          aria-label="Signing secret"
          data-testid="new-secret-value"
          className="min-w-0 flex-1 font-mono"
          value={created.secret}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button variant="outline" onClick={() => void copy()}>
          <Copy />
          Copy
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
      {copied && (
        <p data-testid="copy-state" className="text-xs text-muted-foreground">
          {copied === "yes"
            ? "Copied to the clipboard."
            : "Selected: press Ctrl+C or Cmd+C to copy."}
        </p>
      )}
    </div>
  );
}

/** Create (no `editing`) or edit form; saves with fetch (the page's CSP forbids form posts). */
function RuleFormPanel({
  editing,
  services,
  environments,
  slos,
  onCreated,
  onDone,
}: {
  editing: (AlertRule & { metric: AlertForm["metric"] }) | undefined;
  services: string[];
  /** `meta.environments` names (D-101), offered as suggestions; any value can be typed. */
  environments: string[];
  slos: Slo[];
  onCreated: (created: AlertRuleCreateResponse) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AlertForm>(
    editing ? formFromRule(editing) : emptyForm(services[0] ?? ""),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof AlertForm>(key: K, value: AlertForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const burn = form.metric === "slo_burn_rate";
  // D-103 (6): a new-error-group rule has no threshold, window, pending duration or minimum.
  const newGroup = form.metric === "new_error_group";

  const save = useMutation({
    mutationFn: async () => {
      const request = toRequest(form);
      if (!request.ok) throw new Error(request.message);
      if (editing) {
        await updateAlert(editing.id, request.body);
        return undefined;
      }
      return createAlert(request.body);
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["alerts"] });
      if (result !== undefined) onCreated(result);
      onDone();
    },
    onError: (error) => setProblem(error.message),
  });

  return (
    <fieldset
      data-testid="alert-form"
      className="space-y-4 rounded-lg border border-border bg-muted/30 p-4"
    >
      <legend className="px-1 text-sm font-semibold">
        {editing ? `Edit ${editing.name}` : "New alert rule"}
      </legend>
      <div className="grid gap-3 md:grid-cols-2">
        <Field id="alert-name" label="Name">
          <Input
            id="alert-name"
            value={form.name}
            maxLength={200}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field id="alert-metric" label="Metric">
          <select
            id="alert-metric"
            className={selectClass}
            value={form.metric}
            onChange={(e) => {
              const metric = e.target.value as AlertForm["metric"];
              setForm((f) => ({
                ...f,
                metric,
                threshold:
                  metric === "error_rate"
                    ? "5"
                    : metric === "p95_ms"
                      ? "500"
                      : metric === "slo_burn_rate"
                        ? "14.4"
                        : f.threshold,
              }));
            }}
          >
            {(Object.keys(METRIC_LABEL) as (keyof typeof METRIC_LABEL)[]).map(
              (m) => (
                <option key={m} value={m}>
                  {METRIC_LABEL[m]}
                </option>
              ),
            )}
          </select>
        </Field>
        {burn ? (
          <Field
            id="alert-slo"
            label="SLO"
            hint="The rule takes its service, environment and route from the SLO."
          >
            <select
              id="alert-slo"
              className={selectClass}
              value={form.sloId}
              onChange={(e) => set("sloId", e.target.value)}
            >
              <option value="">Choose an SLO</option>
              {slos.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.service}
                  {s.route ? ` ${s.route}` : ""})
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field
              id="alert-service"
              label={
                newGroup
                  ? "Service (optional, empty for every service)"
                  : "Service"
              }
            >
              <Input
                id="alert-service"
                list="alert-services"
                value={form.service}
                maxLength={256}
                onChange={(e) => set("service", e.target.value)}
              />
              <datalist id="alert-services">
                {services.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
            <Field
              id="alert-route"
              label="Route (optional, empty for the whole service)"
            >
              <Input
                id="alert-route"
                value={form.route}
                maxLength={512}
                placeholder="/orders/:id"
                onChange={(e) => set("route", e.target.value)}
              />
            </Field>
            <Field
              id="alert-environment"
              label="Environment (optional, empty for every environment)"
              hint={
                '"unset" watches only the data sent without an environment.'
              }
            >
              <Input
                id="alert-environment"
                list="alert-environments"
                value={form.environment}
                maxLength={256}
                onChange={(e) => set("environment", e.target.value)}
              />
              <datalist id="alert-environments">
                {environments.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </Field>
          </>
        )}
        {newGroup ? (
          <p
            data-testid="new-group-note"
            className="text-xs text-muted-foreground md:col-span-2"
          >
            Notifies once when an error group is first seen, and again each time
            a resolved group regresses. It has no threshold or window.
          </p>
        ) : (
          <>
            <Field
              id="alert-threshold"
              label={THRESHOLD_UNIT[form.metric] ?? ""}
            >
              <Input
                id="alert-threshold"
                inputMode="decimal"
                value={form.threshold}
                onChange={(e) => set("threshold", e.target.value)}
              />
            </Field>
            <Field id="alert-window" label="Window (minutes, 5 to 60)">
              <Input
                id="alert-window"
                inputMode="numeric"
                value={form.windowMinutes}
                onChange={(e) => set("windowMinutes", e.target.value)}
              />
            </Field>
            <Field
              id="alert-for"
              label="Pending duration (minutes, 0 to 60)"
              hint="How long the condition must hold before the rule fires."
            >
              <Input
                id="alert-for"
                inputMode="numeric"
                value={form.forMinutes}
                onChange={(e) => set("forMinutes", e.target.value)}
              />
            </Field>
            <Field
              id="alert-min"
              label="Minimum requests"
              hint="Fewer requests in the window is no data: the state does not change."
            >
              <Input
                id="alert-min"
                inputMode="numeric"
                value={form.minRequests}
                onChange={(e) => set("minRequests", e.target.value)}
              />
            </Field>
          </>
        )}
        <div className="md:col-span-2">
          <Field
            id="alert-webhook"
            label="Webhook URL"
            hint="Notifications are signed JSON. Addresses that are not public are refused unless the server lists the host in NESTRIX_WEBHOOK_ALLOWED_HOSTS."
          >
            <Input
              id="alert-webhook"
              type="url"
              autoComplete="off"
              value={form.webhookUrl}
              maxLength={2048}
              placeholder="https://hooks.example.com/nestrix"
              onChange={(e) => set("webhookUrl", e.target.value)}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          Enabled
        </label>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-[var(--destructive-text)]">
          {problem}
        </p>
      )}
      <div className="flex gap-2 border-t border-border pt-3">
        <Button
          disabled={save.isPending}
          onClick={() => {
            setProblem(null);
            save.mutate();
          }}
        >
          {editing ? "Save changes" : "Create rule"}
        </Button>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}

function History({ rule, now }: { rule: AlertRule; now: number }) {
  const events = useQuery({
    queryKey: ["alert-events", rule.id],
    queryFn: () => getAlertEvents(rule.id),
  });
  if (events.isError) {
    return (
      <p role="alert" className="text-sm text-[var(--destructive-text)]">
        Could not load the history: {events.error.message}
      </p>
    );
  }
  if (events.data === undefined) {
    return <p className="text-sm text-muted-foreground">Loading history…</p>;
  }
  if (events.data.events.length === 0) {
    return (
      <p data-testid="history-empty" className="text-sm text-muted-foreground">
        No notifications yet. Send a test to see one here.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table data-testid="history" className="w-full text-left text-sm">
        <caption className="sr-only">Delivery history of {rule.name}</caption>
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">When</th>
            <th className="py-1 pr-3 font-medium">Notification</th>
            <th className="py-1 pr-3 font-medium">Value</th>
            <th className="py-1 font-medium">Delivery</th>
          </tr>
        </thead>
        <tbody>
          {events.data.events.map((e: AlertEvent) => (
            <tr
              key={e.id}
              data-testid="history-row"
              className="border-t border-border"
            >
              <td className="py-1.5 pr-3 whitespace-nowrap">
                {formatRelative(e.atUnixMs, now)}
              </td>
              <td className="py-1.5 pr-3">{e.kind}</td>
              <td className="py-1.5 pr-3 font-mono">
                {formatMetricValue(rule.metric, e.value)}
              </td>
              <td className="py-1.5">
                <Chip tone={deliveryTone(e.delivery)}>{e.delivery}</Chip>{" "}
                <span
                  data-testid="delivery-detail"
                  className="text-xs text-muted-foreground"
                >
                  {describeDelivery(e)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RuleCard({
  rule,
  slos,
  now,
  canAdmin,
  onEdit,
}: {
  rule: AlertRule;
  slos: Slo[];
  now: number;
  canAdmin: boolean;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const known = isKnownMetric(rule.metric);
  const remove = useMutation({
    mutationFn: () => deleteAlert(rule.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  });
  const test = useMutation({
    mutationFn: () => testAlert(rule.id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["alert-events", rule.id] }),
  });
  const state = ruleState(rule);
  const slo =
    rule.sloId === null ? undefined : slos.find((s) => s.id === rule.sloId);
  const s = rule.state;
  return (
    <li
      data-testid="alert-rule"
      data-state={state.key}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{rule.name}</h3>
            <Chip tone={state.tone} data-testid="rule-state">
              {state.label}
            </Chip>
            {!known && <Chip tone="info">Read-only</Chip>}
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">
              {rule.service ?? "every service"}
              {rule.route ? ` ${rule.route}` : ""}
              {rule.environment !== null ? ` · ${rule.environment}` : ""}
            </span>
            {slo && ` · SLO "${slo.name}"`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((v) => !v)}
          >
            History
          </Button>
          {canAdmin && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={test.isPending}
                onClick={() => {
                  test.reset();
                  setShowHistory(true);
                  test.mutate();
                }}
              >
                Send test
              </Button>
              {known && (
                <Button variant="outline" size="sm" onClick={onEdit}>
                  Edit
                </Button>
              )}
              {confirming ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Confirm delete
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirming(false)}
                  >
                    Keep
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(true)}
                >
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Fires when</dt>
          <dd data-testid="rule-condition" className="font-mono">
            {conditionText(rule)}
          </dd>
        </div>
        {/* A new-error-group rule stores placeholders here (D-103 (6)): not shown. */}
        {rule.metric !== "new_error_group" && (
          <>
            <div>
              <dt className="text-xs text-muted-foreground">Window</dt>
              <dd data-testid="rule-window">{rule.windowMinutes} min</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Pending for</dt>
              <dd data-testid="rule-for">{rule.forMinutes} min</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                Minimum requests
              </dt>
              <dd data-testid="rule-min">{rule.minRequests}</dd>
            </div>
          </>
        )}
        <div>
          <dt className="text-xs text-muted-foreground">Last value</dt>
          <dd data-testid="rule-value" className="font-mono">
            {formatMetricValue(rule.metric, s.lastValue)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last evaluated</dt>
          <dd>
            {s.lastEvaluatedAtUnixMs === null
              ? "never"
              : formatRelative(s.lastEvaluatedAtUnixMs, now)}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-muted-foreground">Webhook</dt>
          <dd data-testid="rule-webhook" className="truncate font-mono">
            {webhookOrigin(rule.webhookUrl)}
          </dd>
        </div>
      </dl>
      {!known && (
        <p data-testid="unknown-kind" className="text-xs text-muted-foreground">
          This rule kind ({rule.metric}) is newer than this page: it is shown
          read-only. You can still test it, read its history or delete it.
        </p>
      )}
      {test.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Sending test notification…
        </p>
      )}
      {test.isError && (
        <p
          data-testid="test-error"
          role="alert"
          className="text-sm text-[var(--destructive-text)]"
        >
          Could not send the test: {test.error.message}
        </p>
      )}
      {test.data && (
        <p data-testid="test-result" role="status" className="text-sm">
          <Chip tone={deliveryTone(test.data.event.delivery)}>
            Test {test.data.event.delivery}
          </Chip>{" "}
          <span className="text-muted-foreground">
            {describeDelivery(test.data.event)}
          </span>
        </p>
      )}
      {remove.isError && (
        <p role="alert" className="text-sm text-[var(--destructive-text)]">
          Could not delete: {remove.error.message}
        </p>
      )}
      {showHistory && <History rule={rule} now={now} />}
    </li>
  );
}

/** Alert rules of the standalone server: state, create/edit/delete, test and delivery history. */
export function AlertsPage() {
  const [paused] = usePaused();
  const now = useNow();
  const canAdmin = useCanAdmin();
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const standalone = meta.data?.mode === "standalone";
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: getAlerts,
    enabled: standalone,
    refetchInterval: pollInterval(paused) === false ? false : 30_000,
    refetchIntervalInBackground: false,
  });
  // The SLO picker's options; only needed for the form and the SLO name on a rule.
  const slos = useQuery({
    queryKey: ["slos"],
    queryFn: getSlos,
    enabled: standalone,
  });
  const [panel, setPanel] = useState<"new" | AlertRule | null>(null);
  const [created, setCreated] = useState<AlertRuleCreateResponse | null>(null);

  if (meta.data !== undefined && !standalone) {
    return (
      <section aria-label="Alerts" className="space-y-6">
        <PageHeader
          title="Alerts"
          description="Rules, their state and the notifications they sent"
        />
        <EmptyState
          testId="alerts-unavailable"
          title="Alerts need the standalone server"
        >
          Alert rules are evaluated from stored history, which only the
          standalone server keeps.
        </EmptyState>
      </section>
    );
  }

  const list = alerts.data?.rules ?? [];
  const summary = summarizeRules(list);
  const sloList = slos.data?.slos ?? [];
  const editing =
    panel !== null && panel !== "new" && isKnownMetric(panel.metric)
      ? (panel as AlertRule & { metric: AlertForm["metric"] })
      : undefined;
  return (
    <section className="space-y-6" aria-label="Alerts">
      <PageHeader
        title="Alerts"
        description="Rules, their state and the notifications they sent"
        source="computed from stored history"
        controls={
          canAdmin ? (
            <Button
              size="sm"
              disabled={panel !== null}
              onClick={() => setPanel("new")}
            >
              <Plus />
              New rule
            </Button>
          ) : undefined
        }
      />
      {/* Alert values come from the per-minute rollups (counted, not sampled), so the page says
          nothing about sampling. When the protocol marks them "estimated" (#43/#30), say it here. */}
      <PageNote testId="alerts-note">
        <strong className="font-medium text-foreground">No data</strong> means
        the window held fewer requests than the rule's minimum. It changes
        nothing: a firing rule stays firing, so a service that stopped sending
        does not resolve its own alert.
      </PageNote>
      {created && (
        <NewSecret created={created} onDone={() => setCreated(null)} />
      )}
      {alerts.data !== undefined && list.length > 0 && (
        <KpiStrip>
          <StatTile
            testId="kpi-rules"
            label="Rules"
            value={String(summary.rules)}
            source="defined on this server"
          />
          <StatTile
            testId="kpi-firing"
            label="Firing"
            value={String(summary.firing)}
            source="notified, not yet resolved"
          />
          <StatTile
            testId="kpi-pending"
            label="Pending"
            value={String(summary.pending)}
            source="breaching, not for long enough"
          />
          <StatTile
            testId="kpi-no-data"
            label="No data"
            value={String(summary.noData)}
            source="too few requests in the window"
          />
        </KpiStrip>
      )}
      {panel !== null && canAdmin && (panel === "new" || editing) && (
        <RuleFormPanel
          key={panel === "new" ? "new" : panel.id}
          editing={editing}
          services={meta.data?.services ?? []}
          environments={(meta.data?.environments ?? []).map((e) => e.name)}
          slos={sloList}
          onCreated={setCreated}
          onDone={() => setPanel(null)}
        />
      )}
      {alerts.data === undefined && !alerts.isError && (
        <div className="space-y-4" data-testid="alerts-loading">
          <SkeletonKpiStrip />
          <SkeletonList rows={3} />
        </div>
      )}
      {alerts.isError && alerts.data === undefined && (
        <ErrorState
          testId="alerts-error"
          title="Could not load alert rules"
          message={alerts.error?.message}
          onRetry={() => alerts.refetch()}
        />
      )}
      {alerts.data !== undefined &&
        (list.length > 0 ? (
          <ul className="space-y-4" data-testid="alert-rules">
            {list.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                slos={sloList}
                now={now}
                canAdmin={canAdmin}
                onEdit={() => setPanel(rule)}
              />
            ))}
          </ul>
        ) : (
          <EmptyState testId="alerts-empty" title="No alert rules yet">
            Use New rule above to be notified when, for example, the error rate
            of a service stays above 5% for two minutes.
          </EmptyState>
        ))}
    </section>
  );
}
