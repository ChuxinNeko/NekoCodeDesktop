import { app, crashReporter } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { freemem, totalmem } from "node:os";
import { DiagnosticLog, diagnosticError, observeProcessDiagnostics, recordDiagnostic, setDiagnosticLog } from "./diagnostic-log";

// Set the existing app name before getPath: development builds otherwise use
// package.json's name and can cache a different userData directory.
app.setName("NekoCode Desktop");

// Imported first by the main entry so later module initialization is observed too.
try {
	const directory = join(app.getPath("userData"), "logs");
	const log = new DiagnosticLog(directory);
	setDiagnosticLog(log);
	observeProcessDiagnostics(log);
	recordDiagnostic("app.start", {
		version: app.getVersion(), packaged: app.isPackaged,
		platform: process.platform, arch: process.arch, versions: process.versions,
	});
	try {
		const dumps = join(app.getPath("userData"), "CrashDumps");
		mkdirSync(dumps, { recursive: true });
		app.setPath("crashDumps", dumps);
		crashReporter.start({ uploadToServer: false, compress: true });
		recordDiagnostic("crashReporter.ready", { directory: dumps });
	} catch (error) {
		recordDiagnostic("crashReporter.error", diagnosticError(error));
	}
	const sampleMemory = () => recordDiagnostic("process.memory", {
		...process.memoryUsage(), systemFree: freemem(), systemTotal: totalmem(), uptime: process.uptime(),
	});
	sampleMemory();
	const timer = setInterval(sampleMemory, 30_000);
	timer.unref();
	app.on("will-quit", () => { clearInterval(timer); recordDiagnostic("app.willQuit"); });
	app.on("before-quit", () => recordDiagnostic("app.beforeQuit"));
	app.on("child-process-gone", (_event, details) => recordDiagnostic("app.childProcessGone", {
		type: details.type, reason: details.reason, exitCode: details.exitCode, serviceName: details.serviceName,
	}));
	app.on("web-contents-created", (_event, contents) => {
		const id = contents.id;
		contents.on("render-process-gone", (_event, details) => recordDiagnostic("renderer.gone", { id, ...details }));
		contents.on("unresponsive", () => recordDiagnostic("renderer.unresponsive", { id }));
		contents.on("responsive", () => recordDiagnostic("renderer.responsive", { id }));
	});
} catch {
	// Startup still works if the diagnostic directory or runtime is unavailable.
}
