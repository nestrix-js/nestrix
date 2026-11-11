# Security policy

## Reporting a vulnerability

Please report privately, through GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**. Do not open a public issue.

Include what you can: the affected version, the adapter (Express, Fastify, platform-node), a minimal reproduction, and the impact as you see it.

You will get an acknowledgement, and then updates as the report is assessed and fixed. A fix is released before the details are published, and reporters are credited unless they ask not to be.

<!-- Owner action before the first release: enable private vulnerability reporting in the repository settings. -->

## What counts

Nestrix runs inside the host application and can hold request metadata, SQL text and stack traces. These are treated as vulnerabilities:

- The embedded dashboard or its API being reachable when the rules in [docs/architecture.md](docs/architecture.md) §4.7 say it should not be.
- Dashboard data being readable cross-origin.
- Data being recorded that the documented defaults say is not: request or response bodies, bind parameters, headers outside the allowlist.
- Instrumentation changing the host application's security behaviour, for example a guard that stops applying.
- Anything that lets a request crash, stall or exhaust the memory of the host application through Nestrix.
- For the standalone server: bypassing ingest or UI authentication, or reading another service's telemetry.

## Supported versions

Nothing has been released yet. From the first release, security fixes go to the latest minor version; this section will list the supported lines.
