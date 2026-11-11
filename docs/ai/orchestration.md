# How AI agents work on this repository

For the lead agent of a session. The owner runs the lead on **Opus 5.5** and wants the work spread across cheaper models wherever they are good enough, with **Fable 5.2 used only when badly needed** (decision D-5). This file says how.

Subagent definitions live in `.claude/agents/`. Each sets its own model, so picking the agent picks the model.

## The lead's job

1. Read the current backlog file (`docs/backlog/phase-N.md`) and pick the next task whose dependencies are done.
2. Decide: do it yourself, or delegate, and to which tier.
3. If delegating, write a brief (template below) and spawn the agent.
4. When it reports back, check the result yourself: run the task's "Done when" checks and read their output. A subagent's "done" is a claim, not evidence.
5. For anything on the review list below, get an independent review before marking it done.
6. Update the backlog status. Move on.
7. At the end of the phase, write the phase report and stop for the owner.

The lead keeps the design in its head; subagents do not. Keep decisions, cross-task consistency and anything that changes `docs/architecture.md` with the lead.

## Which model for which work

| Tier | Agent | Use it for | Examples here |
|---|---|---|---|
| Haiku | `mechanic` | Bounded, mechanical work with one obvious right answer | Cloning an example app onto another adapter from a template; config files; renames; looking up current versions; running a command and reporting its output; formatting docs |
| Sonnet | `implementer` | Ordinary implementation against a written specification, with tests | Workspace toolchain; package skeletons; CI; the test harness; UI components; option parsing; integration tests; an integration once its spike has fixed the approach |
| Opus | `architect` | Work where the difficulty is in judgement or correctness, not volume | The six spikes; the HTTP hook and context-propagation code; method wrapping; dashboard auth and the security rules; redaction; the OTLP decoder; storage schema; diagnosing a failure nobody understands yet |
| Opus | `reviewer` | Independent review against this project's rules | See the review list |
| Fable | `fable-escalation` | Only under the conditions in "Escalating to Fable" | — |

Default to the cheapest tier that can do the task well. Two checks before choosing:

- **Can the task be specified completely in the brief?** If yes, it is Sonnet or Haiku work. If the agent would have to make design decisions the brief cannot anticipate, it is Opus work, or the lead's own.
- **What does a subtle mistake cost?** Code that runs inside every request of someone else's application, or decides who can see the dashboard, goes to Opus even when it is short.

Do the work yourself when it is a handful of tool calls, or when explaining it would take longer than doing it. Do not spawn an agent to look up one fact.

When a task fails at one tier, do not retry it at the same tier with the same brief. Either the brief was missing something (fix it) or the task needs the next tier up. Record which in the backlog notes.

## Writing a brief

A subagent starts with the project instructions (`AGENTS.md`, which Claude Code loads through `CLAUDE.md`) and your brief, nothing else. It has not seen the conversation, the plan, or what you already tried. Point it at files instead of retyping them.

```markdown
## Goal
What to produce, and what it is for (which task ID, what depends on it).

## Read first
- docs/… (the specific sections that matter)
- existing files to follow as a pattern

## Do
The work, with every decision that is already made stated as a constraint.

## Do not
Scope limits: what to leave alone, what not to add.

## Done when
The exact checks to run and what passing looks like.

## Report back
What you need: files changed, check output, anything that did not work,
anything you had to assume. Ask for facts you verified to be marked apart
from things you inferred.
```

Say what is already known and what is hard. If there is an obvious approach that is wrong here, name it and say why, so the agent does not take it.

## Parallel work

Tasks with no shared files can run at the same time: spawn them in one message. In phase 0, spikes S1, S2, S5 and S6 are independent once the test harness exists. Give each parallel agent that edits files its own worktree (`isolation: worktree`) so they do not collide, and merge the results yourself.

The owner allows up to **10 agents at once** for genuinely independent work. Fan out only as far as you can still check every result yourself; checking is the usual bottleneck.

## Review

Get an independent `reviewer` pass, with the code and the task, not your own conclusions, before marking any of these done:

- Anything that runs in the host's request path (hooks, subscribers, wrappers, the interceptor).
- Anything that decides access to the dashboard, or handles redaction.
- Anything that parses untrusted input (the OTLP receiver).
- Every spike result, before its conclusions are written into `architecture.md`.

If the session has review plugins installed (code-reviewer, security-reviewer, silent-failure-hunter, pr-test-analyzer, performance-reviewer), use the matching one as a second opinion on substantial diffs. They are optional; the `reviewer` agent is the one this project requires.

Review findings are claims too. Check a finding against the code before acting on it.

## Escalating to Fable

Fable costs the most, and the owner has asked that it be used only when badly needed. Use `fable-escalation` only if one of these is true:

1. An Opus-tier attempt has failed **twice**, with different approaches, on a task that blocks the phase.
2. A spike has overturned a core mechanism (context propagation through the request hook, method wrapping, the `pg` wrapper, dashboard mounting) and a replacement design is needed with no written specification to follow.
3. A correctness bug in async-context propagation or in the instrumentation of a third-party library that Opus has not been able to root-cause.

Before spawning it:
- Write the reason, and what was already tried, in the backlog notes for the task.
- Make the brief complete. A Fable run that has to rediscover context wastes exactly what it was chosen to save.
- One Fable task at a time. Ask it for the design or the diagnosis; hand the resulting implementation back to Opus or Sonnet.

If none of the three conditions holds, it is not a Fable task, however large it is. Volume is a reason to split work, not to escalate it.

## Things only the owner decides

Stop and ask; do not pick a default and continue:

- Anything in the "Open" table of `docs/decisions.md`.
- Changing an entry in the decision log.
- Publishing a package, pushing to a remote, creating a release, or committing (the owner asks for commits explicitly; use `git commit -s`).
- Adding a runtime dependency to a published package.
- Spending that is out of proportion to the task: many parallel agents, or Fable.

## Reporting

At a phase gate, or when stopping for any reason, the report says: what is done and verified (with the check that showed it), what is done but not verified, what failed and with what output, what was skipped and why, and what needs the owner. Failed checks are reported with their output, not summarised away.
