---
"@nestrix-js/nestjs": patch
"@nestrix-js/ui": patch
---

Errors page: a "Grouped" view (the default) groups the errors of the last 15 or 60 minutes by error type, normalised message (numbers, UUIDs, hex ids, quoted strings and emails replaced) and route, with count, first and last seen, a trend sparkline and the recent occurrences linking to traces; "All" is the previous list. New `GET api/v1/errors/groups` (embedded and standalone). Built from the stored, sampled traces.
