import type { ComposerInsertion } from "../../../shared/browser";
import type { FusionConfig } from "../../../shared/fusion";
import type { AgentPhase, WorkMode } from "../../../shared/workflow";
import type { ExecutionMode, ModelOption, ThinkingLevel } from "../../../shared/agent";
import { ComposerPickers } from "./chat/ComposerPickers";
import { ComposerShell } from "./chat/ComposerShell";

interface ComposerProps {
	insertion?: ComposerInsertion | null;
	onInsertionConsumed?: (id: string) => void;
	disabled: boolean;
	streaming: boolean;
	models: ModelOption[];
	modelKey: string | null;
	fusion?: FusionConfig | null;
	thinkingLevel: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	mode: ExecutionMode;
	workMode: WorkMode;
	agentPhase: AgentPhase;
	onSend: (text: string) => void;
	onAbort: () => void;
	onSetFusion: (config: FusionConfig) => void;
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
	onSetWorkMode: (mode: WorkMode) => void;
}

/** Composer for an open session: the shared input shell plus the model/thinking/mode pickers. */
export function Composer(props: ComposerProps) {
	return (
		<ComposerShell
			insertion={props.insertion}
			onInsertionConsumed={props.onInsertionConsumed}
			disabled={props.disabled}
			onAbort={props.onAbort}
			onSend={props.onSend}
			streaming={props.streaming}
			toolbar={
				<ComposerPickers
					models={props.models}
					modelKey={props.modelKey}
					fusion={props.fusion}
					thinkingLevel={props.thinkingLevel}
					thinkingLevels={props.thinkingLevels}
					mode={props.mode}
					workMode={props.workMode}
					agentPhase={props.agentPhase}
					disabled={props.streaming || props.disabled}
					onSetFusion={props.onSetFusion}
					onSetModel={props.onSetModel}
					onSetThinking={props.onSetThinking}
					onSetMode={props.onSetMode}
					onSetWorkMode={props.onSetWorkMode}
					onSlashCommands={() => props.onSend("/help")}
				/>
			}
		/>
	);
}
