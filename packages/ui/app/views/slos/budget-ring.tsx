import { ScoreRing } from "@/components/kit/score-ring";
import {
  budgetBarPercent,
  budgetCaption,
  budgetColor,
  budgetState,
  describeBudget,
  formatBudgetPercent,
} from "@/views/slos/slo-format";

/**
 * The error-budget ring of one SLO, on the Overview and the SLOs page. The ring fills with the
 * budget left; an overspent budget is an empty ring in the danger colour, with the overspend
 * written inside ("−150%") instead of a clamped 0%.
 */
export function BudgetRing({
  remainingFraction,
  name,
  valueTestId,
}: {
  remainingFraction: number | null;
  name: string;
  valueTestId?: string;
}) {
  const state = budgetState(remainingFraction);
  return (
    <ScoreRing
      score={budgetBarPercent(remainingFraction)}
      text={formatBudgetPercent(remainingFraction)}
      color={budgetColor(state)}
      label={`${name}: ${describeBudget(remainingFraction)}`}
      caption={budgetCaption(remainingFraction)}
      valueTestId={valueTestId}
      valueClassName={
        remainingFraction !== null && remainingFraction < 0
          ? "text-destructive-text"
          : undefined
      }
    />
  );
}
