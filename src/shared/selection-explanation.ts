/** Ephemeral explanation chat. These turns never belong to an AgentSession. */
export interface ExplanationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ExplainSelectionRequest {
  id: string;
  modelKey: string;
  original: string;
  language: "zh-CN" | "en";
  turns: ExplanationTurn[];
}

export interface ExplainSelectionResult {
  text: string;
}
