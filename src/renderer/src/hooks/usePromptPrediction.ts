import { useEffect, useRef, useState } from "react";
import { optionalApi } from "../api";
import { useTranslation } from "../i18n";
import { predictionTurn, type PredictionContext } from "../lib/promptPrediction";

export function usePromptPrediction(context: PredictionContext | undefined, streaming: boolean, blocked: boolean) {
	const { language } = useTranslation();
	const [settings, setSettings] = useState<{ enabled: boolean; modelKey: string | null } | null>(null);
	const [candidate, setCandidate] = useState<{ key: string; text: string } | null>(null);
	const observed = useRef<string | null>(null);
	const consumed = useRef<string | null>(null);
	const turn = predictionTurn(context);
	const key = turn?.key ?? null;
	const sessionId = context?.sessionId ?? null;
	useEffect(() => {
		if (!context) return;
		let live = true;
		const update = () => {
			setCandidate(null);
			void optionalApi()?.codeIntelStatus().then((status) => { if (live) setSettings(status.prediction); }).catch(() => { if (live) setSettings(null); });
		};
		update();
		window.addEventListener("nekocode:code-intel-changed", update);
		return () => { live = false; window.removeEventListener("nekocode:code-intel-changed", update); };
	}, [!!context]);
	useEffect(() => {
		if (streaming && sessionId) { observed.current = sessionId; setCandidate(null); }
	}, [streaming, sessionId]);
	useEffect(() => { if (blocked) setCandidate(null); }, [blocked]);
	useEffect(() => {
		if (!turn || streaming || observed.current !== sessionId || consumed.current === key) return;
		// No request on opening history, and never interrupt an already-started draft.
		if (blocked) { consumed.current = key; setCandidate(null); return; }
		if (!settings?.enabled || !settings.modelKey) return;
		const bridge = optionalApi();
		if (!bridge?.promptPredict) return;
		consumed.current = key;
		const id = crypto.randomUUID();
		let live = true;
		void bridge.promptPredict({ id, userText: turn.userText, answerText: turn.answerText, language }).then((result) => {
			if (live && result.text) setCandidate({ key: turn.key, text: result.text });
		}).catch(() => {});
		return () => { live = false; void bridge.promptPredictCancel(id).catch(() => {}); };
	}, [key, sessionId, streaming, blocked, settings?.enabled, settings?.modelKey, language]);
	return { text: settings?.enabled && !blocked && !streaming && candidate?.key === key ? candidate.text : "", dismiss: () => setCandidate(null) };
}
