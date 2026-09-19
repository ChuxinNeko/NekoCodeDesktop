import { describe, expect, test } from "bun:test";
import type { UpdateCheckResult } from "../shared/updates";
import { scheduleStartupUpdate, type UpdateNotice } from "../renderer/src/lib/startupUpdate";

const available: UpdateCheckResult = {
	status: "available", currentVersion: "0.0.1", checkedAt: 1000,
	release: { version: "0.1.0", tag: "v0.1.0", name: "New release", notes: "## Improvements\n- Fusion usage", publishedAt: null, url: "https://github.com/ChuxinNeko/NekoCodeDesktop/releases/tag/v0.1.0" },
};

describe("automatic update scheduling", () => {
	test("waits until after startup, then delivers version and release notes", async () => {
		let calls = 0;
		const notices: UpdateNotice[] = [];
		const cancel = scheduleStartupUpdate(async () => { calls++; return available; }, (notice) => notices.push(notice), 1);
		expect(calls).toBe(0);
		await Bun.sleep(15);
		expect(calls).toBe(1);
		expect(notices).toEqual([{ currentVersion: "0.0.1", release: available.release }]);
		cancel();
	});

	test("unmounting before the timer fires cancels the check", async () => {
		let calls = 0;
		const cancel = scheduleStartupUpdate(async () => { calls++; return available; }, () => {}, 1);
		cancel();
		await Bun.sleep(15);
		expect(calls).toBe(0);
	});

	test("ignores results that arrive after unmount", async () => {
		let resolve!: (result: UpdateCheckResult) => void;
		const result = new Promise<UpdateCheckResult>((done) => { resolve = done; });
		const notices: UpdateNotice[] = [];
		const cancel = scheduleStartupUpdate(() => result, (notice) => notices.push(notice), 1);
		await Bun.sleep(15);
		cancel();
		resolve(available);
		await Bun.sleep(1);
		expect(notices).toEqual([]);
	});

	test("up-to-date, ahead, no release, dismissed, and errors remain silent", async () => {
		const results: (UpdateCheckResult | null)[] = [
			{ ...available, status: "up-to-date" }, { ...available, status: "ahead" },
			{ currentVersion: "0.0.1", checkedAt: 1000, status: "no-release" },
			{ currentVersion: "0.0.1", checkedAt: 1000, status: "error", error: "network" }, null,
		];
		const notices: UpdateNotice[] = [];
		const cleanup = results.map((result) => scheduleStartupUpdate(async () => result, (notice) => notices.push(notice), 1));
		cleanup.push(scheduleStartupUpdate(async () => { throw new Error("IPC unavailable"); }, (notice) => notices.push(notice), 1));
		await Bun.sleep(15);
		expect(notices).toEqual([]);
		cleanup.forEach((cancel) => cancel());
	});
});
