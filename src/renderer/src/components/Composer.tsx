import { useState } from "react";
import type { SlashCommandSummary } from "../../../shared/commands";
import type { ComposerInsertion } from "../../../shared/browser";
import type { FastContextConfig } from "../../../shared/fast-context";
import type { FusionConfig } from "../../../shared/fusion";
import type { AgentPhase, WorkMode } from "../../../shared/workflow";
import type { ContextUsage, ExecutionMode, ModelOption, SendPromptRequest, ThinkingLevel } from "../../../shared/agent";
import { api } from "../api";
import { ComposerPickers } from "./chat/ComposerPickers";
import { ComposerShell } from "./chat/ComposerShell";

interface ComposerProps {
	loadCommands?: () => Promise<SlashCommandSummary[]>;
	insertion?: ComposerInsertion | null;
	onInsertionConsumed?: (id: string) => void;
	disabled: boolean;
	streaming: boolean;
	models: ModelOption[];
	modelKey: string | null;
	fastContext: FastContextConfig;
	fusion?: FusionConfig | null;
	thinkingLevel: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	mode: ExecutionMode;
	workMode: WorkMode;
	agentPhase: AgentPhase;
	onSend: (request: SendPromptRequest) => void;
	onSendBackground?: (text: string) => void;
	allowImageAttachments?: boolean;
	context?: ContextUsage;
	onAbort: () => void;
	onSetFusion: (config: FusionConfig) => void;
	onSetFastContext: (config: FastContextConfig) => void;
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
	onSetWorkMode: (mode: WorkMode) => void;
}

/** Composer for an open session: the shared input shell plus the model/thinking/mode pickers. */
export function Composer(props: ComposerProps) {
	// Bumped to ask the shell to open its slash menu. A counter rather than a
	// boolean so the toolbar entry still works after the menu is dismissed.
	const [openCommands, setOpenCommands] = useState(0);
	const supportsImages = props.models.find((model) => model.key === props.modelKey)?.imageInput === true;
	return (
		<ComposerShell
			insertion={props.insertion}
			onInsertionConsumed={props.onInsertionConsumed}
			disabled={props.disabled}
			onAbort={props.onAbort}
			onSend={props.onSend}
			onSendBackground={props.onSendBackground}
			supportsImages={supportsImages}
			allowImageAttachments={props.allowImageAttachments}
			context={props.context}
			streaming={props.streaming}
			loadCommands={props.loadCommands ?? (() => api.agentCommands())}
			openCommandsSignal={openCommands}
			toolbar={
				<ComposerPickers
					models={props.models}
					modelKey={props.modelKey}
					fastContext={props.fastContext}
					fusion={props.fusion}
					thinkingLevel={props.thinkingLevel}
					thinkingLevels={props.thinkingLevels}
					mode={props.mode}
					workMode={props.workMode}
					agentPhase={props.agentPhase}
					disabled={props.streaming || props.disabled}
					onSetFusion={props.onSetFusion}
					onSetFastContext={props.onSetFastContext}
					onSetModel={props.onSetModel}
					onSetThinking={props.onSetThinking}
					onSetMode={props.onSetMode}
					onSetWorkMode={props.onSetWorkMode}
					onSlashCommands={() => setOpenCommands((n) => n + 1)}
				/>
			}
		/>
	);
}
