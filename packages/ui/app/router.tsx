import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppShell } from "@/components/app-shell";
import { NuqsHashAdapter } from "@/lib/nuqs-hash-adapter";
import { isRequestListLink } from "@/lib/params";
import { ClassesPage } from "@/views/classes/classes-page";
import { DependenciesPage } from "@/views/dependencies/dependencies-page";
import { ErrorsPage } from "@/views/errors/errors-page";
import { MapPage } from "@/views/map/map-page";
import { OverviewPage } from "@/views/overview/overview-page";
import { ProfilerPage } from "@/views/profiler/profiler-page";
import { QueriesPage } from "@/views/queries/queries-page";
import { RequestsPage } from "@/views/requests/requests-page";
import { RoutesPage } from "@/views/routes/routes-page";
import { RuntimePage } from "@/views/runtime/runtime-page";
import { SettingsPage } from "@/views/settings/settings-page";
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
// The Overview is home. A link made before it existed (`#/?status=error`) pointed at the request
// list, so a home URL that carries request-list parameters goes to `/requests` with the same ones.
const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ location }) => {
    if (isRequestListLink(location.search)) {
      throw redirect({
        to: "/requests",
        search: location.search as never,
        replace: true,
      });
    }
  },
  component: OverviewPage,
});
const requestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/requests",
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
const queriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queries",
  component: QueriesPage,
});
const dependenciesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dependencies",
  component: DependenciesPage,
});
const profilerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profiler",
  component: ProfilerPage,
});
const runtimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runtime",
  component: RuntimePage,
});
const slosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/slos",
  component: SlosPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
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
    overviewRoute,
    requestsRoute,
    errorsRoute,
    routesRoute,
    classesRoute,
    mapRoute,
    queriesRoute,
    dependenciesRoute,
    profilerRoute,
    runtimeRoute,
    slosRoute,
    settingsRoute,
    traceRoute,
  ]),
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
