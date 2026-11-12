# Route detail: what changed

When the [Overview](/guide/dashboard-tour#overview) says a route got slower or fails more, open the route to see why. The route detail page compares one route with itself on two sides and says, in order of impact, which statement, dependency, method or error explains the change.

It is reached from the Overview (a route in Needs attention or Getting better, or a row of its routes table), from the Routes page (the Details link on a row) and from the trace view ("Route details"). The address is `#/route?method=&route=`; leave `method` out to cover every method of the route.

## Choosing what to compare

- **Previous window** (the default): the last 15 or 60 minutes against the 15 or 60 minutes before them.
- **Release against release**: the route's traces whose `service.version` is one release against those of another, anywhere in the store. The picker lists the route's own releases, newest first; it starts with the two newest. Releases come from the `service.version` resource attribute (the `serviceVersion` option, see the [reference](/reference/configuration)).

## What the page shows

**KPI tiles.** Requests per minute, p95, p99 and error rate with their change, and queries per request. In window mode they come from the route statistics, which count every request before sampling. In release mode the tiles come from the sampled traces of each side.

**What changed.** One sentence, then up to eight findings ranked by how much of the change they explain. Each finding has a direction (worse or better, with an icon and words, never colour alone), a plain title such as `A new statement runs 6.4 times per request (SELECT … FROM order_items WHERE order_id = $1), adding 214 ms.`, a bar for its share of the change and a link:

| Finding | It fires when |
|---|---|
| New statement | A statement that did not run before now runs at least once per request and adds at least 5 ms per request. |
| N+1 | A statement now runs 3 or more times per request and at least twice as often as before, however fast each call is. It takes precedence over "new statement" for the same statement. |
| Slower statement | The same number of calls, but each takes at least 1.5 times as long and the statement adds at least 5 ms per request. |
| Slower dependency | A host, database or Redis the route calls takes at least 1.3 times as long per request and at least 20 ms more. |
| Dependency errors | The error rate of calls to a dependency rose by 5 points or more, with at least 3 failed calls. |
| Slower method | A class method's own time per request is at least 1.5 times as high and at least 10 ms more. |
| New error, more errors | An exception type with no traces before and at least 2 now; or at least 3 times as many traces as before and at least 5. |
| Faster | A statement, dependency or method whose time per request fell by at least 30% and at least 10 ms. |

Findings need at least 5 traces on each side. With fewer, the page says `Not enough traces to compare (N before, M after).` and still shows the tables. A database call is both a statement and a dependency (`postgresql orders-db`), so one change can raise two findings.

A finding opens the page it is about, already filtered, with a "Filtered by" chip you can clear: Queries (the statement text; an N+1 finding also sets the N+1 filter), Dependencies (the host), Classes (the class) or Errors (the route and the exception type).

**Latency histogram.** The Routes page's histogram for the current window. In release mode it still shows the window, and the card says so.

**Where the time goes.** Two stacked bars, one per side, split by kind (database, outgoing HTTP, Redis, messaging, your code, other), as time per request.

**Statements, methods, dependencies and errors.** One table each, per side, with calls and time per request. **Slowest traces**: the ten slowest traces of the later side, each with its own time by kind, linking to the trace view.

## Before sampling or sampled

Every card carries a label, as everywhere in the dashboard. The KPI tiles (in window mode) and the histogram are counted before sampling. Everything else, including the findings, is built from sampled, stored traces, and from at most the newest 2,000 traces per side; the page says so. At a low `sampleRate` a route can have too few stored traces to compare even when its statistics show plenty of requests.

## Limits

The embedded dashboard reads its own memory; the standalone server reads PostgreSQL and loads at most 200,000 spans per side, newest traces first, so a route made of a few huge traces can have a side that is empty (a single trace of more than 200,000 spans is not loaded). "Queries per request" adds up the 20 statements the answer carries, so it is a lower bound for a route with more. See also [large traces](/guide/large-traces).
