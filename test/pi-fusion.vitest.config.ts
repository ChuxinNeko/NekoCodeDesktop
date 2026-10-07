// Scoped SDK regression suite: does not depend on the upstream monorepo's absent vitest.base.ts.
export default {
	test: {
		include: [
			"pi/packages/coding-agent/test/agent-session-compaction-hook.test.ts",
			"pi/packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts",
		],
		testTimeout: 10000,
		restoreMocks: true,
	},
};
