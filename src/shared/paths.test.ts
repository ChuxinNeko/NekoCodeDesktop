import { describe, expect, test } from "bun:test";
import { projectLabel, shortenPath } from "./paths";

describe("projectLabel", () => {
	test("takes the last segment of either separator style", () => {
		expect(projectLabel("D:\\work\\NekoCodeDesktop")).toBe("NekoCodeDesktop");
		expect(projectLabel("/home/ada/projects/pi")).toBe("pi");
	});

	test("ignores a trailing separator and falls back for no project", () => {
		expect(projectLabel("/home/ada/projects/pi/")).toBe("pi");
		expect(projectLabel(null)).toBe("No project");
	});

	test("shows the home directory as a tilde instead of the account name", () => {
		expect(projectLabel("C:\\Users\\ada", "C:\\Users\\ada")).toBe("~");
		expect(projectLabel("C:\\Users\\ada\\work", "C:\\Users\\ada")).toBe("work");
		// Without a home to compare against it stays a plain basename.
		expect(projectLabel("C:\\Users\\ada")).toBe("ada");
	});
});

describe("shortenPath", () => {
	const home = "C:\\Users\\ada";

	test("folds the home directory to a tilde", () => {
		expect(shortenPath(home, home)).toBe("~");
		expect(shortenPath("C:\\Users\\ada\\work\\pi", home)).toBe("~\\work\\pi");
	});

	test("tolerates the drive letter's case and a trailing separator", () => {
		expect(shortenPath("c:\\users\\ada\\work", home)).toBe("~\\work");
		expect(shortenPath("C:\\Users\\ada\\", home)).toBe("~");
	});

	test("leaves paths that only look like a prefix match alone", () => {
		expect(shortenPath("C:\\Users\\adafruit\\work", home)).toBe("C:\\Users\\adafruit\\work");
		expect(shortenPath("D:\\work", home)).toBe("D:\\work");
	});

	test("passes the path through when there is no home to fold", () => {
		expect(shortenPath("/srv/app", "")).toBe("/srv/app");
		expect(shortenPath(null, home)).toBe("");
	});
});
