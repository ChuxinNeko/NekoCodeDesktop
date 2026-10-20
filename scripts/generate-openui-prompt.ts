import { resolve } from "node:path";
import { openuiLibrary, openuiPromptOptions } from "../src/renderer/src/lib/openuiLibrary";

// Keep React and the component library out of the Electron main process.
const target = resolve(import.meta.dir, "../src/main/openui-system-prompt.txt");
const prompt = openuiLibrary.prompt(openuiPromptOptions).trim() + "\n";
if (process.argv.includes("--check")) {
	if (await Bun.file(target).text() !== prompt) throw new Error("OpenUI prompt is stale; run bun run openui:prompt");
} else {
	await Bun.write(target, prompt);
	console.log(`Generated ${target}`);
}
