import {
  columnFilteringFeature,
  columnVisibilityFeature,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/react-table";

/**
 * The table features every list in the dashboard uses. Filtering and sorting are always
 * run by the server (`manualFiltering` / `manualSorting` at the call site); the table only
 * holds their state and renders the controls.
 */
export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowSortingFeature,
});
export type DataTableFeatures = typeof dataTableFeatures;
