# Reference provenance

Source: `demo/fusion/packages/agent/src`, commit `c4ecb1cc4b9d1ecdf4f3580991c8b5095fc8ece5`.

The seven TypeScript files in `provenance.json` are byte-identical copies. Keep orchestration changes out of these files. Desktop integration belongs in the adjacent PI runner, stage driver, session store and runtime.

The engine owns planning, parallel lanes, assignment ordering, worker identities, synthesis, compaction, routing, hooks and run budgets. Its token budget excludes planning and compaction; desktop billing includes these calls separately. The PI runner ports the source AiSdkAgentRunner prompts and 20-step execution/synthesis limits instead of importing its Vercel transport.

Copied regression tests are under `test/main/fusion-reference/`. Only test imports and Vitest-specific matcher names are adapted for Bun.
