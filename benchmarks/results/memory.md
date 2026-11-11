# Memory

darwin-arm64, Node v26.13.0, 3 fresh-process run(s) per configuration, node --expose-gc --import file:///Users/lltamayo/developments/nov/nestrix/.claude/worktrees/agent-a835193b4706e6ab2/benchmarks/src/module-count.mjs. Every value is `process.memoryUsage()` read inside the app right after `gc()`, median across runs. "idle" is 1 s after the first 200; "loaded" is 1 s after 10 s of load on /hello and /users/42 at 64 connections. "modules" counts ESM and CommonJS files loaded (`module.registerHooks` load hook).

| config | phase | RSS MB | heap used MB | heap total MB | external MB | arrayBuffers MB | modules | new space MB | old space MB | code space MB | KB allocated per request |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | idle | 115.9 | 19.1 | 37.5 | 4.6 | 0.4 | 911 | 16 | 17.3 | 1.3 | 0 |
| baseline | loaded | 149.2 | 20.5 | 54.3 | 5.8 | 0.3 | 911 | 29.5 | 19 | 2 | 14.4 |
| interceptor | idle | 116.2 | 19.2 | 37.8 | 4.6 | 0.3 | 911 | 15.8 | 17.5 | 1.3 | 0 |
| interceptor | loaded | 158.3 | 20.9 | 58 | 6.2 | 0.3 | 911 | 32 | 20 | 2.3 | 30.7 |
| noexport | idle | 127.4 | 22.8 | 47.9 | 4.7 | 0.4 | 1176 | 21.5 | 21.3 | 1.3 | 0 |
| noexport | loaded | 230.5 | 23 | 98.4 | 4.8 | 0.4 | 1176 | 62 | 29 | 2.5 | 43.6 |
| sink | idle | 128.1 | 22.9 | 48.4 | 4.7 | 0.4 | 1176 | 22.3 | 21 | 1.3 | 0 |
| sink | loaded | 230.5 | 24 | 113.7 | 5.8 | 0.4 | 1176 | 63.5 | 44 | 2.8 | 48.7 |
