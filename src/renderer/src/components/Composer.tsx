import type { ExecutionMode, ModelOption, ThinkingLevel } from "../../../shared/agent";
import { ComposerPickers } from "./chat/ComposerPickers";
import { ComposerShell } from "./chat/ComposerShell";

interface ComposerProps {
	disabled: boolean;
	streaming: boolean;
	models: ModelOption[];
	modelKey: string | null;
	thinkingLevel: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	mode: ExecutionMode;
	onSend: (text: string) => void;
	onAbort: () => void;
	onSetModel: (modelKey: string) => void;
	onSetThinking: (level: ThinkingLevel) => void;
	onSetMode: (mode: ExecutionMode) => void;
}

/** Composer for an open session: the shared input shell plus the model/thinking/mode pickers. */
export function Composer(props: ComposerProps) {
	return (
		<ComposerShell
			disabled={props.disabled}
			onAbort={props.onAbort}
			onSend={props.onSend}
			streaming={props.streaming}
			toolbar={
				<ComposerPickers
					models={props.models}
					modelKey={props.modelKey}
					thinkingLevel={props.thinkingLevel}
					thinkingLevels={props.thinkingLevels}
					mode={props.mode}
					onSetModel={props.onSetModel}
					onSetThinking={props.onSetThinking}
					onSetMode={props.onSetMode}
					onSlashCommands={() => props.onSend("/help")}
				/>
			}
		/>
	);
}
