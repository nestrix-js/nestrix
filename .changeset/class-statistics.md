---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

Class statistics. While the dashboard is on, calls reported by level 2 method wrappers are counted before sampling per class and method (calls, errors, total and largest duration, bounded at 500 classes by 50 methods), and `GET /_nestrix/api/v1/classes?windowMinutes=15|60` returns the window sums plus an own-time estimate per method taken from the sampled spans in the store.
