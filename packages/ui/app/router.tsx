import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { NuqsHashAdapter } from "@/lib/nuqs-hash-adapter";
import { ClassesPage } from "@/views/classes/classes-page";
import { ErrorsPage } from "@/views/errors/errors-page";
import { MapPage } from "@/views/map/map-page";
import { ProfilerPage } from "@/views/profiler/profiler-page";
import { RequestsPage } from "@/views/requests/requests-page";
import { RoutesPage } from "@/views/routes/routes-page";
import { SlosPage } from "@/views/slos/slos-page";
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
const classesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/classes",
  component: ClassesPage,
});
const mapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/map",
  component: MapPage,
});
const profilerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profiler",
  component: ProfilerPage,
});
const slosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/slos",
  component: SlosPage,
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
    classesRoute,
    mapRoute,
    profilerRoute,
    slosRoute,
    traceRoute,
  ]),
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
