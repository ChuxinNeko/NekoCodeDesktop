import { useEffect, useState } from "react";
import type { SandboxDeployment } from "../../../../shared/ssh";
import { api } from "../../api";
import { useTranslation } from "../../i18n";

export function useSandboxDeployments() {
	const [states, setStates] = useState<Record<string, SandboxDeployment>>({});
	useEffect(() => {
		let live = true;
		const changed = new Set<string>();
		const off = api.onSandboxDeployment(state => {
			changed.add(state.hostId);
			if (live) setStates(current => ({ ...current, [state.hostId]: state }));
		});
		void api.sshSandboxDeployments().then(snapshot => {
			if (live) setStates(current => ({ ...Object.fromEntries(snapshot.filter(state => !changed.has(state.hostId)).map(state => [state.hostId, state])), ...current }));
		}).catch(() => {});
		return () => { live = false; off(); };
	}, []);
	return states;
}

export function SandboxDeploymentStatus({ state }: { state?: SandboxDeployment }) {
	const { t } = useTranslation();
	if (!state) return null;
	return <p role={state.phase === "error" ? "alert" : "status"} className={`break-words whitespace-pre-wrap text-xs ${state.phase === "error" ? "text-destructive" : "text-muted-foreground"}`}>
		{t(`ssh.sandboxDeployment.${state.phase}`)}{state.error ? `\n${state.error}` : ""}
	</p>;
}
