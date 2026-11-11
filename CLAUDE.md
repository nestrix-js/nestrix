@AGENTS.md

## Claude Code

The project instructions are in `AGENTS.md`, imported above. Edit that file, not this one, unless the change applies to Claude Code only.

The owner runs the lead session on Opus 5.5 and wants Fable 5.2 used only when badly needed. Subagent definitions are in `.claude/agents/`; each sets its own model, so choosing the agent chooses the model:

| Agent | Model | For |
|---|---|---|
| `mechanic` | Haiku | Mechanical, fully specified work |
| `implementer` | Sonnet | Implementation against a written spec, with tests |
| `architect` | Opus | Spikes; request-path, security and correctness-critical code; hard diagnosis |
| `reviewer` | Opus | Independent review against the rules in `AGENTS.md` |
| `fable-escalation` | Fable | Last resort, under the three conditions in `docs/ai/orchestration.md` |

Subagents load this file, and through it `AGENTS.md`, when they start.
