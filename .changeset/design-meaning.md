---
"@nestrix-js/ui": patch
---

Dashboard: an overspent SLO error budget shows as "−150%, over budget" on the Overview as well as on the SLOs page (it was clamped to "0%, budget spent"), one ring on both. Changes against a previous window that does not exist are no longer drawn as a dash in tile corners and "change" columns. The sampling caveat is said once per page, in its header, and the header chip states the rate ("traces sampled at 25%") and is hidden on pages that do not show sampled data. "Trace not found" explains itself per mode and holds the id. SLOs share one burn-rate scale, explain the marker once and style Delete as destructive; the Alerts note is no longer joined to a sampling note.
