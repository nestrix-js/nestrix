---
"@nestrix-js/ui": minor
---

Add an Alerts page to the standalone dashboard (#19). It lists alert rules with their service and route, metric, threshold, window, pending duration, minimum requests and state (firing, pending, resolved, no data, disabled); creates, edits and deletes rules, with an SLO picker for burn-rate rules; sends a signed test notification; and shows each rule's delivery history (status, HTTP status, error category). The signing secret of a new rule is shown once, and the list shows only the origin of a webhook URL. No server change: the page uses the existing alerts API.
