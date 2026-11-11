import type { Page } from "@playwright/test";

/** Everything that must stay empty for the CSP and the build to count as clean. */
export function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) =>
    problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  return problems;
}

// Registered before any page script runs, so no violation can be missed.
export async function recordViolations(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__violations.push(
        `${e.violatedDirective} blocked ${e.blockedURI || "inline"}`,
      );
    });
  });
}

export const violations = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __violations: string[] }).__violations,
  );

export const requestRows = (page: Page) =>
  page.getByTestId("requests").locator("tbody tr");

/** Trace ids of the rows, in order (each row's route links to its trace). */
export const rowTraceIds = (page: Page) =>
  page
    .getByTestId("requests")
    .locator("tbody tr a")
    .evaluateAll((links) =>
      links.map((a) => (a.getAttribute("title") ?? "").toString()),
    );
