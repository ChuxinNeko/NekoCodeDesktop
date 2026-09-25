import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ComputerHost, type WorkerProcess } from "./host";
import { COMPUTER_TOOL_NAMES, createComputerTools, type ComputerPointer } from "./tools";

/**
 * Computer Use for the whole app: one driver worker, one set of tools.
 *
 * Only Windows for now. The driver supports macOS too, but there it needs the
 * Accessibility and Screen Recording grants attributed to this app, which has
 * its own setup flow that does not exist yet.
 */
export class ComputerUseService {
	private readonly host: ComputerHost;
	private readonly definitions: ToolDefinition[];

	constructor(
		private readonly options: {
			enabled: () => boolean;
			fork: () => WorkerProcess;
			/** The on-screen agent cursor; absent in tests and headless use. */
			pointer?: ComputerPointer & { dispose(): void };
			platform?: NodeJS.Platform;
		},
	) {
		this.host = new ComputerHost({ fork: options.fork });
		this.definitions = createComputerTools(this.host, options.pointer);
	}

	static supported(platform: NodeJS.Platform = process.platform): boolean {
		return platform === "win32";
	}

	private active(): boolean {
		return ComputerUseService.supported(this.options.platform) && this.options.enabled();
	}

	tools(): ToolDefinition[] {
		return this.active() ? this.definitions : [];
	}

	toolNames(): string[] {
		return this.active() ? [...COMPUTER_TOOL_NAMES] : [];
	}

	/** Cut off whatever the driver is doing, e.g. when the setting is switched off. */
	stop(): void {
		this.host.stop();
	}

	dispose(): void {
		this.host.dispose();
		this.options.pointer?.dispose();
	}
}
