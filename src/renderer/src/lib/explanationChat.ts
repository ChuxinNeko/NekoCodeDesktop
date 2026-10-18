import type { ExplainSelectionRequest, ExplainSelectionResult, ExplanationTurn } from "../../../shared/selection-explanation";
import type { Language, TranslateFn } from "../i18n";
import type { ChatMessage, ChatComposerLabels } from "../components/primitives/ChatComposer";

export interface ExplanationChatState {
  turns: ExplanationTurn[];
  busy: boolean;
  error: boolean;
}

/** Owns only the popup's turns; it has no main-session sender or mutable cells. */
export class ExplanationChat {
  private state: ExplanationChatState = { turns: [], busy: false, error: false };
  private disposed = false;
  private requestId: string | null = null;

  constructor(private readonly context: { original: string; modelKey: string | null; language: Language },
    private readonly transport: {
      request: (request: ExplainSelectionRequest) => Promise<ExplainSelectionResult>;
      cancel: (id: string) => Promise<void>;
    },
    private readonly changed: (state: ExplanationChatState) => void,
  ) {}

  async send(text: string): Promise<void> {
    if (this.disposed || this.state.busy || !text.trim()) return;
    // A failed, unanswered question is replaced when the user submits another.
    const turns = this.state.error ? this.state.turns.slice(0, -1) : this.state.turns;
    this.state = { turns: [...turns, { role: "user", text: text.trim() }], busy: true, error: false };
    await this.perform();
  }

  async retry(): Promise<void> {
    if (this.disposed || this.state.busy || !this.state.error) return;
    this.state = { ...this.state, busy: true, error: false };
    await this.perform();
  }

  dispose(): void {
    this.disposed = true;
    if (this.requestId) void this.transport.cancel(this.requestId).catch(() => undefined);
  }

  private async perform(): Promise<void> {
    this.changed(this.state);
    const id = crypto.randomUUID();
    this.requestId = id;
    try {
      if (!this.context.modelKey) throw new Error("No model selected");
      const result = await this.transport.request({ ...this.context, modelKey: this.context.modelKey, id, turns: this.state.turns });
      if (!result.text.trim()) throw new Error("Empty explanation");
      if (!this.disposed) {
        this.state = { turns: [...this.state.turns, { role: "assistant", text: result.text }], busy: false, error: false };
        this.changed(this.state);
      }
    } catch {
      if (!this.disposed) {
        this.state = { ...this.state, busy: false, error: true };
        this.changed(this.state);
      }
    } finally {
      this.requestId = null;
    }
  }
}

export function explanationMessages(state: ExplanationChatState, t: TranslateFn): ChatMessage[] {
  const messages: ChatMessage[] = state.turns.map((turn, index) => ({
    id: String(index), role: turn.role, body: turn.text,
    label: t("selection.chat.assistant"), sub: "", time: "",
  }));
  if (state.busy) messages.push({ id: "pending", role: "assistant", label: t("selection.chat.assistant"), sub: "", time: "", body: t("selection.chat.pending"), pending: true });
  return messages;
}

export function explanationLabels(t: TranslateFn): ChatComposerLabels {
  return {
    initialPrompt: t("selection.chat.initialPrompt"), placeholder: t("selection.chat.placeholder"),
    prompt: t("selection.chat.prompt"), send: t("selection.chat.send"), action: t("selection.chat.action"),
  };
}
