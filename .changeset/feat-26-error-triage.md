---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

Error triage in the standalone server (#26). The Errors page shows the stored state of each group (open, resolved, regressed, ignored) and, against the standalone server, lets an admin resolve, ignore or reopen a group; ignored groups are listed under their own view and counted. The embedded dashboard accepts the new `triage` parameter and ignores it. New alert rule kind `new_error_group` notifies once about each new or regressed error group.
