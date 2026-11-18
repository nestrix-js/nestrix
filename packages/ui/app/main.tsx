import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { getActiveEnvironment } from "./lib/api";
import { environmentQueryHash } from "./lib/query-key";
import { router } from "./router";
import "./styles.css";

// Polls repeat every two seconds anyway, so a failed request is shown as such at once
// instead of being retried with back-off.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      queryKeyHashFn: (key) =>
        environmentQueryHash(key, getActiveEnvironment()),
    },
  },
});
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
