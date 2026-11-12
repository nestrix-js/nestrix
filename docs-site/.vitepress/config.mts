import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Nestrix",
  description:
    "Nest-aware OpenTelemetry tracing for NestJS 12+, with an optional dashboard.",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/configuration" },
      { text: "FAQ", link: "/faq" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Levels 1 to 3", link: "/guide/levels" },
        ],
      },
      {
        text: "Using Nestrix",
        items: [
          { text: "Dashboard", link: "/guide/dashboard" },
          { text: "Dashboard tour", link: "/guide/dashboard-tour" },
          { text: "Route detail", link: "/guide/route-detail" },
          { text: "Large traces", link: "/guide/large-traces" },
          { text: "Security model", link: "/guide/security" },
          { text: "Standalone server", link: "/guide/standalone-server" },
          { text: "MCP for AI assistants", link: "/guide/mcp" },
          { text: "Microservices", link: "/guide/microservices" },
          { text: "Logs and metrics", link: "/guide/logs-and-metrics" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Configuration", link: "/reference/configuration" },
          { text: "Compatibility", link: "/reference/compatibility" },
          { text: "Upgrading from 0.x", link: "/reference/upgrading" },
          { text: "FAQ", link: "/faq" },
        ],
      },
    ],
    search: { provider: "local" },
    outline: [2, 3],
  },
});
