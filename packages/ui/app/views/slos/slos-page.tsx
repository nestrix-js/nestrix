import type { Slo } from "@nestrix-js/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import {
  Chip,
  EmptyState,
  ErrorState,
  KpiStrip,
  PageHeader,
  ScoreRing,
  SkeletonKpiStrip,
  SkeletonList,
  StatTile,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSlo, deleteSlo, getMeta, getSlos, updateSlo } from "@/lib/api";
import { pollInterval, usePaused } from "@/lib/live";
import { cn } from "@/lib/utils";
import {
  budgetBarPercent,
  budgetColor,
  budgetState,
  burnBarPercent,
  describeBudget,
  describeIndicator,
  emptyForm,
  formatBurnRate,
  formatPercent,
  formFromSlo,
  type SloForm,
  summarizeSlos,
  toRequest,
} from "@/views/slos/slo-format";

const selectClass =
  "h-8 w-full rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

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
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof SloForm>(key: K, value: SloForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      const request = toRequest(form);
      if (!request.ok) throw new Error(request.message);
      return editing
        ? updateSlo(editing.id, request.body)
        : createSlo(request.body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["slos"] });
      onDone();
    },
    onError: (error) => setProblem(error.message),
  });

  return (
    <fieldset
      data-testid="slo-form"
      className="space-y-4 rounded-lg border border-border bg-muted/30 p-4"
    >
      <legend className="px-1 text-sm font-semibold">
        {editing ? `Edit ${editing.name}` : "New SLO"}
      </legend>
      <div className="grid gap-3 md:grid-cols-2">
        <Field id="slo-name" label="Name">
          <Input
            id="slo-name"
            value={form.name}
            maxLength={200}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field id="slo-service" label="Service">
          <Input
            id="slo-service"
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
        </Field>
        <Field
          id="slo-route"
          label="Route (optional, empty for the whole service)"
        >
          <Input
            id="slo-route"
            value={form.route}
            maxLength={512}
            placeholder="/orders/:id"
            onChange={(e) => set("route", e.target.value)}
          />
        </Field>
        <Field id="slo-kind" label="Kind">
          <select
            id="slo-kind"
            className={selectClass}
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
          </select>
        </Field>
        {form.kind === "latency" && (
          <Field id="slo-threshold" label="Threshold (ms)">
            <Input
              id="slo-threshold"
              inputMode="decimal"
              value={form.latencyThresholdMs}
              onChange={(e) => set("latencyThresholdMs", e.target.value)}
            />
          </Field>
        )}
        <Field id="slo-objective" label="Objective (%)">
          <Input
            id="slo-objective"
            inputMode="decimal"
            value={form.objectivePercent}
            onChange={(e) => set("objectivePercent", e.target.value)}
          />
        </Field>
        <Field id="slo-window" label="Window">
          <select
            id="slo-window"
            className={selectClass}
            value={form.windowDays}
            onChange={(e) =>
              set("windowDays", e.target.value === "7" ? "7" : "30")
            }
          >
            <option value="7">7 days</option>
            <option value="30">30 days</option>
          </select>
        </Field>
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
          {editing ? "Save changes" : "Create SLO"}
        </Button>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}

const BURN_SCALE_MIN = 2;

/**
 * Burn rate of the last 1 h and 6 h as two bars on one scale. 1x is the pace that spends the
 * budget exactly over the window (the marker); the API gives these two windows, not a series.
 */
function BurnBars({ slo }: { slo: Slo }) {
  const rates = [
    { id: "1h", label: "1 h", rate: slo.status.burnRate["1h"] },
    { id: "6h", label: "6 h", rate: slo.status.burnRate["6h"] },
  ] as const;
  const max = Math.max(BURN_SCALE_MIN, ...rates.map((r) => r.rate ?? 0));
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
      <p className="text-xs text-muted-foreground">
        Marker: 1x, the pace that spends the budget over the window.
      </p>
    </div>
  );
}

function SloCard({ slo, onEdit }: { slo: Slo; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
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
        </div>
      </div>
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
          <ScoreRing
            score={width}
            color={budgetColor(state)}
            label={describeBudget(status.errorBudget.remainingFraction)}
            caption={state === "none" ? "no data" : "budget left"}
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
        <BurnBars slo={slo} />
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
            value={
              lowest === null
                ? "—"
                : lowest < 0
                  ? `-${Math.round(-lowest * 100)}`
                  : String(Math.round(lowest * 100))
            }
            unit={lowest === null ? undefined : "%"}
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
          <ul className="space-y-4" data-testid="slos">
            {list.map((slo) => (
              <SloCard key={slo.id} slo={slo} onEdit={() => setPanel(slo)} />
            ))}
          </ul>
        ) : (
          <EmptyState testId="slos-empty" title="No SLOs yet">
            Use New SLO above to track an objective, such as 99.9% of checkout
            requests without a 5xx over 30 days, against the stored history.
          </EmptyState>
        ))}
    </section>
  );
}
