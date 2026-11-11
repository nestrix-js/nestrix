<!-- The owner's original brief, kept verbatim as the record of intent (2026-11-11).
     It was written as a planning prompt, so it addresses an assistant directly.
     Where it and docs/decisions.md differ, docs/decisions.md wins: those changes were approved by the owner. -->

# Nestrix — Open-Source NestJS Observability Platform

## Your Role

Act as a principal software architect, senior TypeScript/NestJS engineer, observability specialist, and experienced open-source maintainer.

We are planning a new open-source project called **Nestrix**, a lightweight, modular, plug-and-play observability and monitoring solution specifically designed for **NestJS 12 and later**.

You are responsible for independently evaluating the product vision, researching existing solutions, identifying architectural risks, proposing improvements, and designing a practical implementation strategy.

**You are currently operating in PLAN MODE.**

Your responsibility at this stage is to research, analyze, recommend, and produce an actionable development plan.

Do not begin implementing application code until the proposed plan and important architectural decisions have been reviewed and approved.

Treat this prompt as a product vision and engineering direction, not a rigid technical specification.

You are encouraged to challenge assumptions, propose alternatives, remove unnecessary complexity, and introduce better solutions.

---

## 1. Product Vision

Nestrix aims to provide a developer-friendly observability solution that integrates into existing NestJS applications with minimal effort.

Our primary goals are:

- Plug-and-play integration for existing NestJS applications.
- Support for NestJS 12+.
- Lightweight and low-overhead runtime instrumentation.
- Modular, independently installable monitoring capabilities.
- Automatic instrumentation wherever technically feasible.
- Optional embedded and standalone monitoring interfaces.
- Support for headless telemetry collection.
- Compatibility with established observability standards.
- Open-source distribution and community extensibility.
- Production-oriented design without unnecessary complexity.

The ideal developer experience should be as simple as installing an npm package, configuring minimal integration, and immediately obtaining useful application insights.

We want to avoid requiring developers to modify existing controllers, services, repositories, or business logic merely to enable basic monitoring.

However, do not promise zero-code instrumentation for capabilities that technically require bootstrap changes, explicit instrumentation, or other integration steps.

Make those limitations clear.

---

## 2. Target Users and Application Environments

The initial target audience is developers and teams maintaining NestJS applications.

Potential environments include:

- Simple NestJS REST APIs.
- Modular monoliths.
- NestJS microservices.
- Applications using Prisma, Drizzle, MikroORM, or TypeORM.
- Applications using BullMQ.
- Applications using Kafka and other supported transports.
- Containerized applications.
- Multi-instance production deployments.

Do not assume every environment must be supported in the MVP.

Evaluate compatibility requirements and recommend an appropriate initial scope.

Our initial framework compatibility target is **NestJS 12+**.

Investigate the actual NestJS 12 runtime requirements, package compatibility, ESM/CommonJS behavior, and supported integration mechanisms before making implementation decisions.

---

## 3. Plug-and-Play Developer Experience

Developer experience is one of the most important differentiators of Nestrix.

Ideally, developers should be able to install the primary SDK through npm, pnpm, or another supported package manager.

An illustrative installation might be:

```bash
pnpm add @nestrix-js/nestjs
```

An illustrative integration might resemble:

```typescript
@Module({
  imports: [
    NestrixModule.forRoot({
      serviceName: 'my-api',
    }),
  ],
})
export class AppModule {}
```

These examples are conceptual, not required API designs.

Investigate how much automatic instrumentation can genuinely be achieved through NestJS module initialization versus earlier application bootstrap instrumentation.

If certain capabilities require preload hooks, OpenTelemetry initialization, Node.js import hooks, or other startup modifications, design the simplest practical developer experience.

Consider whether an initialization CLI would improve integration:

```bash
npx nestrix init
```

Do not assume a CLI is necessary until its value is evaluated.

The goal is to minimize developer effort without compromising reliability, correctness, or runtime compatibility.

---

## 4. Modular and Lightweight Architecture

Nestrix must follow a modular, opt-in design.

Developers should only need to install the integrations they intend to use.

Potential packages include:

```text
@nestrix-js/core
@nestrix-js/nestjs
@nestrix-js/http
@nestrix-js/prisma
@nestrix-js/drizzle
@nestrix-js/mikro-orm
@nestrix-js/bullmq
@nestrix-js/kafka
@nestrix-js/otel
@nestrix-js/ui
```

These package names and boundaries are illustrative.

You may consolidate, split, rename, remove, or introduce packages if doing so produces a better architecture.

Avoid creating separate packages merely for theoretical modularity.

Evaluate:

- Dependency footprint.
- Runtime overhead.
- Tree-shaking and module loading.
- Optional and peer dependencies.
- Package compatibility.
- Independent versioning versus unified releases.
- Build and distribution complexity.
- Open-source maintainability.
- Contributor experience.

The objective is meaningful modularity, not an unnecessarily fragmented ecosystem.

---

## 5. Observability Capabilities

Potential capabilities include:

### HTTP Monitoring

- Request tracing.
- Response status monitoring.
- Request latency and duration.
- Error rates.
- Endpoint performance.
- Request correlation.

### Exception Monitoring

- Unhandled exceptions.
- Error classification.
- Stack traces where appropriate.
- Error correlation with active traces.

### Database Monitoring

- Database operation timing.
- Slow-query detection.
- Query correlation with requests.
- Database performance insights.
- Optional ORM-specific instrumentation.

### Background Job Monitoring

- Job execution duration.
- Failed jobs.
- Retries.
- Queue processing metrics.
- Trace correlation.

### Microservice Monitoring

- Distributed tracing.
- Service-to-service request correlation.
- Message processing latency.
- Supported transport instrumentation.
- Service dependency visibility.

### Additional Capabilities

- Application logs.
- Custom metrics.
- Custom tracing.
- Application health monitoring.
- Performance insights.

These are possible product capabilities, not mandatory MVP requirements.

Your responsibility is to determine which are worth building first, which should be postponed, and which can be delegated to established observability technologies.

Avoid duplicating mature infrastructure without clear justification.

---

## 6. OpenTelemetry and Interoperability

Evaluate OpenTelemetry as a foundational component of Nestrix.

Investigate:

- OpenTelemetry SDK integration.
- Automatic instrumentation.
- Context propagation.
- Trace and span management.
- Metrics and logging support.
- OTLP exporters.
- Existing collector compatibility.
- Compatibility with applications already using OpenTelemetry.
- Instrumentation initialization order.
- Potential duplicate instrumentation.
- Dependency and version conflicts.

Nestrix should ideally support existing observability infrastructure rather than forcing users into a proprietary backend.

Consider integrations with systems such as Jaeger, Grafana Tempo, and OpenTelemetry Collector.

Avoid implementing custom telemetry protocols unless there is a compelling and documented reason.

Nestrix should not require its own monitoring server merely to collect and export telemetry.

---

## 7. Deployment and Usage Models

Evaluate three potential operating modes.

### A. Embedded Mode

Developers install Nestrix directly into their existing NestJS application.

An optional monitoring UI could be accessible through a configured application route.

Example:

```text
http://localhost:3000/_nestrix
```

Possible characteristics:

- Minimal setup.
- Suitable for development and debugging.
- Optional local telemetry storage.
- No required external database for a basic experience.
- No mandatory standalone monitoring server.

Evaluate whether embedded monitoring introduces unacceptable operational, security, memory, or performance risks.

Do not assume a full embedded dashboard is necessary for the MVP.

### B. Standalone Mode

Nestrix operates as a separate monitoring service.

Multiple NestJS applications send telemetry to a centralized backend.

Potential capabilities:

- Centralized monitoring.
- Persistent storage.
- Multi-service tracing.
- Historical telemetry.
- Dashboard access.
- Production-oriented deployment.

Consider Docker-based self-hosting.

### C. Headless Mode

Developers install only the instrumentation SDK.

Telemetry is exported to existing observability systems without requiring any Nestrix UI or server.

Evaluate which modes should be implemented first.

Prioritize architecture reuse and avoid maintaining duplicate instrumentation pipelines.

---

## 8. Database and Storage Architecture

### Primary ORM Preference: Drizzle

**Drizzle ORM is the preferred primary ORM and relational database access layer for Nestrix's own backend.**

PostgreSQL is the preferred initial relational database.

Where relational storage is appropriate, prefer:

- Drizzle ORM.
- Drizzle schema definitions.
- Drizzle migrations.
- Type-safe database queries.
- Efficient SQL access.
- Minimal runtime overhead.

Avoid introducing Prisma, TypeORM, or another ORM into Nestrix's backend without a compelling technical justification.

However, do not blindly assume that PostgreSQL and Drizzle are appropriate for every observability workload.

Observability systems can generate significant telemetry volumes.

Evaluate:

- Relational storage.
- Time-series storage.
- Trace storage.
- Retention strategies.
- Data partitioning.
- Indexing.
- Data ingestion performance.
- Storage growth.
- Query performance.
- Operational complexity.

You may propose specialized storage technologies when justified by workload characteristics and maintainability.

Avoid introducing multiple databases prematurely.

### Important Distinction

Drizzle is our preferred ORM for **Nestrix's own backend**.

It must not become a required dependency of applications being monitored.

Nestrix should support applications using other ORMs or database access methods through optional integrations.

---

## 9. Frontend and Dashboard — Research and Approval Required

**The frontend technology has intentionally not been decided.**

Do not automatically select Next.js, React, Vite, or another framework based on assumptions or previous suggestions.

You must independently evaluate the frontend architecture and recommend the most suitable solution.

The frontend should potentially support:

- Embedded monitoring dashboards.
- Standalone monitoring dashboards.
- Shared UI components.
- Real-time or near-real-time monitoring.
- Trace exploration.
- Performance charts.
- Filtering and searching telemetry.
- Error investigation.
- Future extensibility.

Consider relevant technologies, including but not limited to:

- React.
- Vite.
- Next.js.
- TanStack Router.
- Other appropriate frontend frameworks.
- Shared component libraries.
- Static frontend asset distribution.

Evaluate the implications of embedding a monitoring interface inside an existing NestJS backend.

For example, determine whether a statically built SPA would be simpler and more efficient than requiring a dedicated frontend server.

Consider:

- Bundle size.
- Runtime requirements.
- Hosting simplicity.
- Embedded deployment.
- Standalone deployment.
- Shared UI architecture.
- SSR necessity.
- Performance.
- Developer experience.
- Build tooling.
- Long-term maintainability.

### Mandatory Frontend Decision Process

Before finalizing the frontend architecture:

1. Research viable frontend approaches.
2. Compare their strengths and limitations.
3. Recommend your preferred approach.
4. Explain why it best fits Nestrix.
5. Identify meaningful trade-offs.
6. Present alternatives.
7. **Ask me to approve or revise your recommendation.**

Do not finalize the frontend framework or dashboard architecture without my input.

You may recommend additional frontend technologies or architecture patterns if appropriate.

---

## 10. Performance and Reliability

Nestrix must minimize the impact of monitoring on the host application.

Important principles include:

- Non-blocking telemetry collection.
- Asynchronous exporting.
- Bounded buffers and queues.
- Configurable sampling.
- Predictable memory usage.
- Graceful handling of exporter failures.
- Reasonable telemetry volume.
- Controlled resource consumption.
- Minimal startup impact.
- Avoiding unnecessary work when integrations are disabled.

Observability failures must not interrupt the core functionality of monitored applications.

Investigate how to measure runtime overhead rather than relying on theoretical claims.

Recommend benchmarks covering:

- Request latency.
- Throughput.
- CPU utilization.
- Memory consumption.
- Startup overhead.
- Behavior during telemetry backend outages.

Define reasonable performance targets based on evidence rather than arbitrary guarantees.

---

## 11. Security and Privacy

Observability systems may process sensitive operational and application data.

Consider:

- Authentication and authorization for monitoring interfaces.
- Secure telemetry transport.
- Sensitive data redaction.
- Personally identifiable information.
- Request and response body collection.
- Credentials and tokens.
- Database query parameters.
- Data retention.
- Production access restrictions.
- Multi-tenant isolation where applicable.

Sensitive request content should not be collected automatically without appropriate safeguards.

Embedded dashboards must not expose application internals publicly by default.

Do not add enterprise security infrastructure prematurely, but ensure the foundational architecture does not create avoidable security risks.

---

## 12. Repository and Development Architecture

Evaluate an appropriate repository structure.

A monorepo may be beneficial because Nestrix could include:

- Instrumentation SDKs.
- NestJS integration packages.
- Optional plugins.
- Backend services.
- Dashboard applications.
- Shared UI components.
- Example applications.
- Documentation.
- Testing and benchmarking tools.

Possible technologies include:

- pnpm workspaces.
- Turborepo.
- TypeScript.
- NestJS.
- Drizzle.
- Vitest.
- Docker.
- OpenTelemetry.

These are candidate tools, not a required implementation stack, except for the stated NestJS compatibility target and strong Drizzle preference.

Select tooling based on actual project needs.

Avoid unnecessary scaffolding, abstractions, and build complexity.

Pay special attention to npm package publishing, type declarations, module compatibility, and reproducible builds.

---

## 13. Open-Source Strategy

Nestrix is intended to become a genuine open-source project.

Consider:

- Appropriate open-source licensing.
- Contributor guidelines.
- README and documentation.
- Public API stability.
- Semantic versioning.
- Release automation.
- Package publishing.
- Automated testing.
- Compatibility matrices.
- Community-developed integrations.
- Examples and starter applications.

Evaluate MIT and Apache-2.0, including their implications for commercial adoption, redistribution, and patent grants.

Licensing should be presented for owner approval rather than silently finalized.

Aim for an approachable contributor experience.

Do not introduce complex governance processes before they are needed.

---

## 14. Architectural Autonomy

You have broad authority to improve this plan.

You may:

- Challenge technical assumptions.
- Recommend better technologies.
- Remove proposed components.
- Introduce missing architectural considerations.
- Restructure package boundaries.
- Redesign integration mechanisms.
- Recommend different storage approaches.
- Propose new developer experience improvements.
- Change feature priorities.
- Simplify the MVP.
- Identify security or performance risks.
- Reject solutions that introduce unnecessary complexity.

Do not follow suggestions mechanically.

Distinguish between:

**Product requirements:** The outcomes Nestrix must deliver.

**Technical preferences:** Our preferred tools and implementation approaches.

**Open decisions:** Areas requiring research or owner approval.

**Future possibilities:** Features that should not unnecessarily complicate the MVP.

When recommending changes, explain the reasoning and trade-offs.

Avoid changing core product goals without approval.

---

## 15. Planning Expectations

Produce a practical, implementation-ready architectural plan.

The plan should cover:

### Product and MVP

- Refined product vision.
- MVP feature scope.
- Explicitly deferred features.
- Core developer experience.
- Primary use cases.

### Architecture

- High-level system architecture.
- SDK and instrumentation design.
- Package boundaries.
- Telemetry collection and export pipeline.
- Deployment modes.
- Backend responsibilities.
- Storage strategy.
- Frontend recommendations.

### Technical Validation

- NestJS 12+ compatibility.
- OpenTelemetry integration.
- Relevant existing libraries.
- Technical risks.
- Dependency considerations.
- Security implications.
- Performance considerations.

### Implementation Roadmap

Break implementation into manageable phases.

Each phase should have:

- Clear objectives.
- Deliverables.
- Dependencies.
- Acceptance criteria.
- Validation and testing requirements.

Prioritize functional vertical slices rather than extensive scaffolding.

### Developer Experience

Explain how a developer would:

1. Install Nestrix.
2. Integrate it into an existing NestJS application.
3. Enable only desired functionality.
4. View or export telemetry.
5. Extend instrumentation when necessary.

Include illustrative APIs or configuration examples where useful.

Do not treat conceptual examples as finalized interfaces.

---

## 16. Decisions Requiring My Approval

You should independently decide ordinary implementation details when the rationale is clear.

However, explicitly request my approval before finalizing:

1. **Frontend framework and dashboard architecture** — research alternatives and make a recommendation.
2. **Open-source license** — recommend an appropriate license and explain the trade-offs.
3. **Major deviations from the agreed product vision** — especially changes affecting modularity, plug-and-play integration, or NestJS compatibility.
4. **Significant operational commitments** — such as introducing mandatory external infrastructure or paid services.

You may include other questions if the answers materially affect the architecture.

Avoid asking unnecessary questions that can be resolved through reasonable engineering judgment.

Present a clear recommended default for each decision rather than asking me to design the system.

---

## 17. Important Constraints

- NestJS 12+ is the initial framework compatibility target.
- Nestrix must be open-source.
- The SDK must remain lightweight and modular.
- Monitoring capabilities should be independently optional where practical.
- The UI must be optional.
- Nestrix must support a useful headless mode.
- Drizzle is the preferred primary backend ORM.
- Existing applications must not be required to adopt Drizzle.
- Favor interoperability with OpenTelemetry.
- Avoid mandatory vendor lock-in.
- Prioritize minimal integration effort.
- Avoid premature microservices and unnecessary infrastructure.
- Do not claim zero runtime overhead.
- Do not assume all proposed features belong in the MVP.
- Frontend selection requires my review and approval.

Everything else may be evaluated and improved.

---

## 18. Your Immediate Task

**Start with research and architectural planning only.**

First, investigate the current NestJS ecosystem, compatible instrumentation approaches, OpenTelemetry support, and existing tools that could be reused.

Then critically assess this proposal.

Identify:

- What assumptions are correct?
- What assumptions are questionable?
- What requirements are missing?
- What is unnecessarily complicated?
- Which existing technologies should be reused?
- What would make Nestrix genuinely useful to NestJS developers?
- What is the smallest viable implementation that validates the product?

Produce your recommended architecture and phased implementation plan.

Give particular attention to the frontend decision, including a comparison of viable approaches and your recommended option.

**Ask for my approval on the frontend architecture and other owner-controlled decisions before moving from planning to implementation.**

Do not simply agree with everything in this prompt.

Your value is in improving the plan through independent engineering judgment, research, and practical trade-off analysis.

The ultimate objective is to create a reliable, lightweight, modular, open-source observability product that NestJS developers will genuinely want to install and maintain.

**Think critically, research thoroughly, challenge assumptions, and recommend the simplest architecture capable of evolving into a serious production-quality project.**
