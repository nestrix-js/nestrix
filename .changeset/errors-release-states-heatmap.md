---
"@nestrix-js/ui": minor
"@nestrix-js/nestjs": minor
---

**Errors page: releases, real states, a weekday by hour grid and errors per release.** Each error group now says which release(s) it was seen in (the newest, and the first when it differs), and its state (New, Regressed, Ongoing, Quiet) is computed by the backend from every stored occurrence instead of being guessed from the window: Regressed means seen before, absent for 24 hours or a whole release, and back. A new "When errors happen" card shows error events by weekday and hour (UTC) over the last 7 days, or what the embedded store holds, and "Errors per release" charts events per 1,000 requests where requests are counted. New endpoint `GET <path>/api/v1/errors/insights` (embedded and standalone server); `errors/groups` gains optional fields (`state`, `firstEverUnixMs`, `lastEverUnixMs`, `firstSeenRelease`, `lastSeenRelease`, `releases`, `history`). All additions are optional, so older clients keep working.
