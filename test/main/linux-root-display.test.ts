import { expect, test } from "bun:test";
import { authorizeRootDisplay } from "../../src/main/linux-root-display";

test("grants only local root and revokes its own grant once", () => {
	const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
	const release = authorizeRootDisplay({ DISPLAY: ":10.0", XAUTHORITY: "/home/morax/.Xauthority", HOME: "/home/morax", API_KEY: "secret", LD_PRELOAD: "bad.so" }, (args, env) => {
		calls.push({ args, env });
		return { status: 0, stdout: "access control enabled\nSI:localuser:morax\n" };
	});
	expect(calls.map((call) => call.args)).toEqual([[], ["+SI:localuser:root"]]);
	expect(calls[1]!.env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C", DISPLAY: ":10.0", XAUTHORITY: "/home/morax/.Xauthority", HOME: "/home/morax" });
	release(); release();
	expect(calls.map((call) => call.args)).toEqual([[], ["+SI:localuser:root"], ["-SI:localuser:root"]]);
});

test("preserves root access that already belongs to the desktop", () => {
	const calls: string[][] = [];
	const release = authorizeRootDisplay({ DISPLAY: ":1" }, (args) => {
		calls.push(args); return { status: 0, stdout: "access control enabled\n    SI:localuser:root\n" };
	});
	release();
	expect(calls).toEqual([[]]);
});

test("fails before handoff if display authorization cannot be inspected or granted", () => {
	expect(() => authorizeRootDisplay({}, () => { throw Error("must not run"); })).toThrow("display");
	expect(() => authorizeRootDisplay({ DISPLAY: ":1" }, () => ({ status: null, stdout: "" }))).toThrow("xhost");
	expect(() => authorizeRootDisplay({ DISPLAY: ":1" }, (args) => ({ status: args.length ? 1 : 0, stdout: "" }))).toThrow("refused");
});
