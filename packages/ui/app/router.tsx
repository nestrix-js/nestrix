import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { NuqsHashAdapter } from "@/lib/nuqs-hash-adapter";
import { ErrorsPage } from "@/views/errors/errors-page";
import { RequestsPage } from "@/views/requests/requests-page";
import { RoutesPage } from "@/views/routes/routes-page";
import { TracePage } from "@/views/trace/trace-page";

// The nuqs adapter reads the router through hooks, so it lives inside the router tree.
const rootRoute = createRootRoute({
  component: () => (
    <NuqsHashAdapter>
      <AppShell>
        <Outlet />
      </AppShell>
    </NuqsHashAdapter>
  ),
});
const requestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RequestsPage,
});
const errorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/errors",
  component: ErrorsPage,
});
const routesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/routes",
  component: RoutesPage,
});
const traceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/traces/$traceId",
  component: function Trace() {
    return <TracePage traceId={traceRoute.useParams().traceId} />;
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    requestsRoute,
    errorsRoute,
    routesRoute,
    traceRoute,
  ]),
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
