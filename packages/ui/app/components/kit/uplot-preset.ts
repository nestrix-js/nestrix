// The one uPlot look: every uPlot chart in the dashboard (the line charts, the latency histogram,
// the requests timeline) builds its axes here. uPlot's own legend is off; the kit draws a legend
// of its own next to the plot. Times are HH:mm, values go through the page's formatters.
import type uPlot from "uplot";

import { crossesDay, timeAxisLabels, yTickLabel } from "./chart-axis";

/** A colour from the page's custom properties, read at draw time so it follows light and dark. */
export const cssColor = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
  "currentColor";

/** What every axis shares: small muted labels on faint gridlines. */
export function axisBase(): Pick<uPlot.Axis, "stroke" | "grid" | "ticks"> {
  return {
    stroke: cssColor("--muted-foreground"),
    grid: { stroke: cssColor("--border"), width: 1 },
    ticks: { stroke: cssColor("--border"), width: 1 },
  };
}

/** The x axis of a time series (x in Unix seconds): HH:mm, with dates only across midnight. */
export function timeAxis(): uPlot.Axis {
  return {
    ...axisBase(),
    space: 70,
    values: (u, splits) => {
      const { min, max } = u.scales.x;
      const across =
        min !== undefined &&
        min !== null &&
        max !== undefined &&
        max !== null &&
        crossesDay(min * 1000, max * 1000);
      return timeAxisLabels(splits, across);
    },
  };
}

/** A y axis in the page's unit; zero is a bare "0". */
export function valueAxis(
  format: (value: number) => string,
  size = 68,
): uPlot.Axis {
  return {
    ...axisBase(),
    size,
    values: (_u, splits) => splits.map((v) => yTickLabel(v, format)),
  };
}

/** uPlot's built-in legend, switched off. */
export const NO_LEGEND: uPlot.Legend = { show: false };
