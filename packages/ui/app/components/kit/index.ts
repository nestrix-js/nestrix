// The dashboard's shared kit. Every page builds on these; see "Design rules and the kit" in
// packages/ui/README.md.
export { AreaChart, type AreaSeries, type ChartMarker } from "./area-chart";
export { BarCell } from "./bar-cell";
export { BarChart, type BarItem } from "./bar-chart";
export { Chip } from "./chip";
export { chipTone, Delta, isUnknownDelta, toneText } from "./delta";
export {
  DONUT_RADIUS,
  Donut,
  DonutLegend,
  type LegendItem,
  Swatch,
} from "./donut";
export {
  ConfirmAction,
  type FieldControlProps,
  FormActions,
  FormField,
  FormPanel,
  FormProblem,
  focusField,
} from "./form";
export {
  barPercent,
  type ChipTone,
  compactNumber,
  type DonutSlice,
  donutSlices,
  heatLevel,
  heatOpacity,
  niceMax,
  ringDasharray,
  type StackSegment,
  stackHeights,
  type Tone,
} from "./format";
export { Heatmap } from "./heatmap";
export { Chart, type ChartSeries } from "./line-chart";
export { PageHeader } from "./page-header";
export { PageNote } from "./page-note";
export { useRegisterPageSource } from "./page-source";
export { ScoreRing } from "./score-ring";
export { Section } from "./section";
export { SegmentedControl } from "./segmented-control";
export {
  SkeletonChart,
  SkeletonKpiStrip,
  SkeletonList,
  SkeletonStatTile,
} from "./skeletons";
export { SOURCE_TEXT, type SourceKind, SourceLabel } from "./source-label";
export { Sparkline } from "./sparkline";
export { KpiStrip, StatTile } from "./stat-tile";
export { EmptyState, ErrorState } from "./states";
export { TrendLine } from "./trend-line";
