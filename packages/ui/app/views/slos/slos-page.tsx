import type { Slo, SloCreate } from "@nestrix-js/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import {
  Chip,
  ConfirmAction,
  EmptyState,
  ErrorState,
  FormActions,
  FormField,
  FormPanel,
  FormProblem,
  focusField,
  KpiStrip,
  PageHeader,
  SkeletonKpiStrip,
  SkeletonList,
  StatTile,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { createSlo, deleteSlo, getMeta, getSlos, updateSlo } from "@/lib/api";
import { pollInterval, usePaused } from "@/lib/live";
import { cn } from "@/lib/utils";
import { BudgetRing } from "@/views/slos/budget-ring";
import {
  budgetBarPercent,
  budgetState,
  burnBarPercent,
  describeBudget,
  describeIndicator,
  emptyForm,
  formatBudgetPercent,
  formatBurnRate,
  formatPercent,
  formFromSlo,
  type SloForm,
  summarizeSlos,
  toRequest,
} from "@/views/slos/slo-format";

/** Create (no `editing`) or edit form; saves with fetch (the page's CSP forbids form posts). */
function SloFormPanel({
  editing,
  services,
  onDone,
}: {
  editing: Slo | undefined;
  services: string[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SloForm>(
    editing ? formFromSlo(editing) : emptyForm(services[0] ?? ""),
  );
  // A problem with one field (shown under it) or with the request (shown above the buttons).
  const [invalid, setInvalid] = useState<{
    field: keyof SloForm;
    message: string;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof SloForm>(key: K, value: SloForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (invalid?.field === key) setInvalid(null);
  };
  const errorOf = (key: keyof SloForm) =>
    invalid?.field === key ? invalid.message : null;

  const save = useMutation({
    mutationFn: async (body: SloCreate) =>
      editing ? updateSlo(editing.id, body) : createSlo(body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["slos"] });
      onDone();
    },
    onError: (error) => setProblem(error.message),
  });
  const submit = () => {
    setProblem(null);
    const request = toRequest(form);
    if (!request.ok) {
      setInvalid({ field: request.field, message: request.message });
      focusField(FIELD_ID[request.field]);
      return;
    }
    setInvalid(null);
    save.mutate(request.body);
  };

  return (
    <FormPanel
      testId="slo-form"
      returnFocusTo={editing ? undefined : "new-slo"}
      title={editing ? `Edit ${editing.name}` : "New SLO"}
      onSubmit={submit}
      onCancel={onDone}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <FormField id="slo-name" label="Name" required error={errorOf("name")}>
          {(p) => (
            <Input
              {...p}
              value={form.name}
              maxLength={200}
              onChange={(e) => set("name", e.target.value)}
            />
          )}
        </FormField>
        <FormField
          id="slo-service"
          label="Service"
          required
          error={errorOf("service")}
        >
          {(p) => (
            <>
              <Input
                {...p}
                list="slo-services"
                value={form.service}
                maxLength={256}
                onChange={(e) => set("service", e.target.value)}
              />
              <datalist id="slo-services">
                {services.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </>
          )}
        </FormField>
        <FormField
          id="slo-route"
          label="Route (optional, empty for the whole service)"
        >
          {(p) => (
            <Input
              {...p}
              value={form.route}
              maxLength={512}
              placeholder="/orders/:id"
              onChange={(e) => set("route", e.target.value)}
            />
          )}
        </FormField>
        <FormField id="slo-kind" label="Kind" required>
          {(p) => (
            <Select
              {...p}
              className="w-full"
              value={form.kind}
              onChange={(e) =>
                set(
                  "kind",
                  e.target.value === "latency" ? "latency" : "availability",
                )
              }
            >
              <option value="availability">Availability (no 5xx)</option>
              <option value="latency">Latency (under a threshold)</option>
            </Select>
          )}
        </FormField>
        {form.kind === "latency" && (
          <FormField
            id="slo-threshold"
            label="Threshold (ms)"
            required
            hint="A request is good when it finishes faster than this."
            error={errorOf("latencyThresholdMs")}
          >
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                placeholder="300"
                value={form.latencyThresholdMs}
                onChange={(e) => set("latencyThresholdMs", e.target.value)}
              />
            )}
          </FormField>
        )}
        <FormField
          id="slo-objective"
          label="Objective (%)"
          required
          hint="99.9 allows 0.1% of requests to be bad over the window."
          error={errorOf("objectivePercent")}
        >
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              value={form.objectivePercent}
              onChange={(e) => set("objectivePercent", e.target.value)}
            />
          )}
        </FormField>
        <FormField id="slo-window" label="Window" required>
          {(p) => (
            <Select
              {...p}
              className="w-full"
              value={form.windowDays}
              onChange={(e) =>
                set("windowDays", e.target.value === "7" ? "7" : "30")
              }
            >
              <option value="7">7 days</option>
              <option value="30">30 days</option>
            </Select>
          )}
        </FormField>
      </div>
      {problem && <FormProblem>{problem}</FormProblem>}
      <FormActions
        submit={editing ? "Save changes" : "Create SLO"}
        pending={save.isPending}
        onCancel={onDone}
      />
    </FormPanel>
  );
}

const FIELD_ID: Record<keyof SloForm, string> = {
  name: "slo-name",
  service: "slo-service",
  route: "slo-route",
  kind: "slo-kind",
  latencyThresholdMs: "slo-threshold",
  objectivePercent: "slo-objective",
  windowDays: "slo-window",
};

const BURN_SCALE_MIN = 2;

/** The end of the burn-rate scale shared by every card: at least the largest rate shown. */
function burnScaleMax(slos: readonly Slo[]): number {
  return Math.max(
    BURN_SCALE_MIN,
    ...slos.flatMap((s) => [
      s.status.burnRate["1h"] ?? 0,
      s.status.burnRate["6h"] ?? 0,
    ]),
  );
}

/**
 * Burn rate of the last 1 h and 6 h as two bars on one scale, the same on every card so bars
 * compare across SLOs. 1x is the pace that spends the budget exactly over the window (the
 * marker, explained once under the list); the API gives these two windows, not a series.
 */
function BurnBars({ slo, max }: { slo: Slo; max: number }) {
  const rates = [
    { id: "1h", label: "1 h", rate: slo.status.burnRate["1h"] },
    { id: "6h", label: "6 h", rate: slo.status.burnRate["6h"] },
  ] as const;
  const marker = burnBarPercent(1, max);
  const takeaway = rates
    .map((r) => `${r.label} ${formatBurnRate(r.rate)}`)
    .join(", ");
  return (
    <div className="min-w-0 space-y-2" data-testid="burn-chart">
      <p className="text-xs font-medium text-muted-foreground">Burn rate</p>
      <div
        role="img"
        aria-label={`Burn rate: ${takeaway}; 1x spends the budget exactly over the window`}
        className="space-y-2"
      >
        {rates.map((r) => {
          const fast = r.rate !== null && r.rate >= 1;
          return (
            <div key={r.id} className="flex items-center gap-2 text-xs">
              <span className="w-8 shrink-0 text-muted-foreground">
                {r.label}
              </span>
              <span className="relative h-2 min-w-0 flex-1 rounded-full bg-muted">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${burnBarPercent(r.rate, max)}%`,
                    background: `var(${fast ? "--destructive" : "--success"})`,
                  }}
                />
                <span
                  aria-hidden
                  className="absolute -top-0.5 -bottom-0.5 w-px bg-foreground/60"
                  style={{ left: `${marker}%` }}
                />
              </span>
              <span
                data-testid={`burn-${r.id}`}
                className="w-12 shrink-0 text-right font-mono tabular-nums"
              >
                {formatBurnRate(r.rate)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SloCard({
  slo,
  burnMax,
  onEdit,
}: {
  slo: Slo;
  burnMax: number;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteSlo(slo.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["slos"] }),
  });
  const { status } = slo;
  const state = budgetState(status.errorBudget.remainingFraction);
  const width = budgetBarPercent(status.errorBudget.remainingFraction);
  return (
    <li
      data-testid="slo"
      data-state={state}
      className="space-y-4 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{slo.name}</h3>
            {status.breached && <Chip tone="worse">Breached</Chip>}
            {!status.breached && state === "low" && (
              <Chip tone="warn">Budget low</Chip>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">
              {slo.service}
              {slo.route ? ` ${slo.route}` : ""}
            </span>
            {" · "}
            {describeIndicator(slo)} · last {slo.windowDays} days
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <ConfirmAction
            label="Delete"
            confirmLabel="Confirm delete"
            subject={slo.name}
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </div>
      </div>
      {remove.isError && (
        <FormProblem>Could not delete: {remove.error.message}</FormProblem>
      )}
      <div className="grid items-center gap-5 md:grid-cols-[auto_1fr_1fr]">
        <div
          role="progressbar"
          aria-label={`Error budget of ${slo.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={width}
          data-testid="budget-bar"
          className="mx-auto md:mx-0"
        >
          <BudgetRing
            remainingFraction={status.errorBudget.remainingFraction}
            name={slo.name}
          />
        </div>
        <div className="min-w-0 space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Objective</dt>
              <dd data-testid="objective" className="font-mono">
                {formatPercent(slo.objective)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Attainment</dt>
              <dd
                data-testid="attainment"
                className={cn(
                  "font-mono",
                  status.breached && "text-[var(--destructive-text)]",
                )}
              >
                {formatPercent(status.attainment)}
              </dd>
            </div>
          </dl>
          <p
            data-testid="budget-text"
            className="text-xs text-muted-foreground"
          >
            {describeBudget(status.errorBudget.remainingFraction)}
            {status.totalRequests > 0 &&
              ` (${Math.round(status.badRequests)} bad of ${status.totalRequests} requests)`}
          </p>
        </div>
        <BurnBars slo={slo} max={burnMax} />
      </div>
    </li>
  );
}

/** SLOs of the standalone server: objective, attainment, budget ring and burn rates. */
export function SlosPage() {
  const [paused] = usePaused();
  const meta = useQuery({ queryKey: ["meta"], queryFn: getMeta });
  const standalone = meta.data?.mode === "standalone";
  const slos = useQuery({
    queryKey: ["slos"],
    queryFn: getSlos,
    enabled: standalone,
    refetchInterval: pollInterval(paused) === false ? false : 30_000,
    refetchIntervalInBackground: false,
  });
  // "new" | an SLO being edited | closed.
  const [panel, setPanel] = useState<"new" | Slo | null>(null);

  if (meta.data !== undefined && !standalone) {
    return (
      <section aria-label="SLOs" className="space-y-6">
        <PageHeader
          title="SLOs"
          description="Objectives, error budgets and burn rate per route"
        />
        <EmptyState
          testId="slos-unavailable"
          title="SLOs need the standalone server"
        >
          SLOs are computed from stored history, which only the standalone
          server keeps.
        </EmptyState>
      </section>
    );
  }

  const list = slos.data?.slos ?? [];
  const summary = summarizeSlos(list);
  const lowest = summary.lowestBudget;
  return (
    <section className="space-y-6" aria-label="SLOs">
      <PageHeader
        title="SLOs"
        description="Objectives, error budgets and burn rate per route"
        source="computed from stored history"
        controls={
          <Button
            id="new-slo"
            size="sm"
            disabled={panel !== null}
            onClick={() => setPanel("new")}
          >
            <Plus />
            New SLO
          </Button>
        }
      />
      {slos.data !== undefined && list.length > 0 && (
        <KpiStrip>
          <StatTile
            testId="kpi-slos"
            label="SLOs"
            value={String(summary.count)}
            source="defined on this server"
          />
          <StatTile
            testId="kpi-breached"
            label="Breached"
            value={String(summary.breached)}
            source="attainment under the objective"
          />
          <StatTile
            testId="kpi-budget"
            label="Lowest budget left"
            value={formatBudgetPercent(lowest)}
            source="the SLO closest to spending it"
          />
          <StatTile
            testId="kpi-burn"
            label="Fastest burn, 1 h"
            value={
              summary.worstBurn1h === null
                ? "—"
                : formatBurnRate(summary.worstBurn1h)
            }
            source="1x spends the budget over the window"
          />
        </KpiStrip>
      )}
      {panel !== null && (
        <SloFormPanel
          key={panel === "new" ? "new" : panel.id}
          editing={panel === "new" ? undefined : panel}
          services={meta.data?.services ?? []}
          onDone={() => setPanel(null)}
        />
      )}
      {slos.data === undefined && !slos.isError && (
        <div className="space-y-4" data-testid="slos-loading">
          <SkeletonKpiStrip />
          <SkeletonList rows={3} />
        </div>
      )}
      {slos.isError && slos.data === undefined && (
        <ErrorState
          testId="slos-error"
          title="Could not load SLOs"
          message={slos.error?.message}
          onRetry={() => slos.refetch()}
        />
      )}
      {slos.data !== undefined &&
        (list.length > 0 ? (
          <>
            <ul className="space-y-4" data-testid="slos">
              {list.map((slo) => (
                <SloCard
                  key={slo.id}
                  slo={slo}
                  burnMax={burnScaleMax(list)}
                  onEdit={() => setPanel(slo)}
                />
              ))}
            </ul>
            <p
              data-testid="burn-note"
              className="text-xs text-muted-foreground"
            >
              Burn rate: the thin marker on each bar is 1x, the pace that spends
              the budget exactly over the window. All bars share one scale.
            </p>
          </>
        ) : (
          <EmptyState testId="slos-empty" title="No SLOs yet">
            Use New SLO above to track an objective, such as 99.9% of checkout
            requests without a 5xx over 30 days, against the stored history.
          </EmptyState>
        ))}
    </section>
  );
}
