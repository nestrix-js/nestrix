---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": minor
---

Roles in the dashboard and new-error-group alerts (#34 with #19 and #26). A viewer of the standalone server (`meta.access.role` is `viewer`) no longer sees write controls: the Alerts page hides create, edit, test and delete, and the Errors page hides the resolve, ignore and reopen buttons (the server refused those writes already). The Alerts form now creates and edits `new_error_group` rules (service, route and environment optional; no threshold or window) and takes an environment for every rule kind except SLO burn rate, which takes it from its SLO. In `@nestrix-js/nestjs`, log lines held for undecided traces under tail sampling are also bounded by about 4 MiB of text per process; a line past the bound is dropped and counted, as past the count bounds.
