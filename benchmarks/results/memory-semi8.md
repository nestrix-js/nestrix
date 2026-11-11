# Memory

darwin-arm64, Node v26.13.0, 2 fresh-process run(s) per configuration, node --expose-gc --import file:///Users/lltamayo/developments/nov/nestrix/.claude/worktrees/agent-a835193b4706e6ab2/benchmarks/src/module-count.mjs --max-semi-space-size=8. Every value is `process.memoryUsage()` read inside the app right after `gc()`, median across runs. "idle" is 1 s after the first 200; "loaded" is 1 s after 10 s of load on /hello and /users/42 at 64 connections. "modules" counts ESM and CommonJS files loaded (`module.registerHooks` load hook).

| config | phase | RSS MB | heap used MB | heap total MB | external MB | arrayBuffers MB | modules | new space MB | old space MB | code space MB | KB allocated per request |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | idle | 116 | 19.2 | 37.4 | 4.6 | 0.3 | 911 | 15.8 | 17.4 | 1 | 0 |
| baseline | loaded | 136.2 | 20.5 | 41.7 | 6.8 | 0.3 | 911 | 16 | 19.9 | 2 | 14.5 |
| noexport | idle | 121.7 | 22.8 | 41.9 | 4.7 | 0.4 | 1175 | 16 | 21.1 | 1.3 | 0 |
| noexport | loaded | 185.7 | 23 | 68.5 | 4.9 | 0.4 | 1175 | 16 | 46 | 2.4 | 43.9 |
