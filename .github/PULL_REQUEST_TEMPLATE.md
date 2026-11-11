## What this changes and why

## How it was checked

<!-- The commands you ran and what they printed. -->

## Checklist

- [ ] Commits are signed off (`git commit -s`)
- [ ] Docs updated where behaviour changed (`docs/architecture.md` is the source of truth)
- [ ] Request-path code has a fault-injection test showing the host request still succeeds
- [ ] Tested on Express, Fastify and platform-node, or the description says which and why
- [ ] No new runtime dependency in a published package, or a maintainer agreed to it
- [ ] I have not consulted `@nestjs/observe` later than 0.3.20 (see CONTRIBUTING.md)
