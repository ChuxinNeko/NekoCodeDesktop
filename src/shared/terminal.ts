export interface TerminalCreateRequest {
	cwd: string;
	cols: number;
	rows: number;
}

export interface TerminalSession {
	id: string;
}

export interface TerminalResizeRequest {
	id: string;
	cols: number;
	rows: number;
}

export interface TerminalInputRequest {
	id: string;
	data: string;
}

export interface TerminalOutput {
	id: string;
	data: string;
}

export interface TerminalExit {
	id: string;
	exitCode: number;
	signal?: number;
}
