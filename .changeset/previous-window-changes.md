---
"@nestrix-js/ui": minor
"@nestrix-js/nestjs": minor
---

**Dependencies, Classes and Map show the change against the previous window.** The three answers now carry the window just before the current one of the same length (optional fields: `previousCovered`, `note`, `previousTotals`, and `previous` on every dependency, class and edge), in the embedded dashboard and the standalone server. The tiles show their change, the Dependencies and Map tables a "p95 change" column and the Classes table an "Avg change" column; a window that statistics do not cover yet shows "—" with the reason. Older servers keep working and show "—".
