import type {
  AgentRole,
  FusionEvent,
  FusionMessage,
  FusionUsage,
} from "../main/fusion/reference/core/types";

type RunStatus = "complete" | "failed" | "idle" | "running";
type LaneStatus = "complete" | "failed" | "idle" | "running";

const ANSI_ESCAPE_SEQUENCE = new RegExp(
  String.raw`\u001B\[[0-?]*[ -/]*[@-~]`,
  "gu",
);

export interface FusionState {
  error?: string;
  events: FusionEvent[];
  history: FusionTurn[];
  lanes: Record<AgentRole, LaneStatus>;
  models?: { main: string; sidekick: string };
  output: string;
  reasoning: string;
  prompt: string;
  sessionId?: string;
  status: RunStatus;
  usage?: FusionUsage;
}

export interface FusionTurn {
  error?: string;
  events: FusionEvent[];
  output: string;
  prompt: string;
  reasoning: string;
  status: "complete" | "failed";
  usage?: FusionUsage;
}

export type FusionAction =
  | { type: "run.submitted"; prompt: string }
  | { type: "event.received"; event: FusionEvent }
  | { type: "run.failed"; message: string };

export function createInitialState(): FusionState {
  return {
    events: [],
    history: [],
    lanes: { main: "idle", sidekick: "idle" },
    output: "",
    reasoning: "",
    prompt: "",
    status: "idle",
  };
}

export function fusionReducer(
  state: FusionState,
  action: FusionAction,
): FusionState {
  if (action.type === "run.submitted") {
    const archived = archiveCurrentTurn(state);
    return {
      ...createInitialState(),
      history:
        archived === undefined ? state.history : [...state.history, archived],
      prompt: action.prompt,
      status: "running",
    };
  }
  if (action.type === "run.failed") {
    return {
      ...state,
      error: cleanErrorMessage(action.message),
      status: "failed",
    };
  }

  const event = action.event;
  const next: FusionState = {
    ...state,
    events: [...state.events, event],
    sessionId: event.sessionId,
  };
  switch (event.type) {
    case "session.started":
      return { ...next, models: event.models, status: "running" };
    case "task.started":
      return { ...next, lanes: { ...next.lanes, [event.role]: "running" } };
    case "task.completed":
      return { ...next, lanes: { ...next.lanes, [event.role]: "complete" } };
    case "task.failed":
      return { ...next, lanes: { ...next.lanes, [event.role]: "failed" } };
    case "tool.started":
    case "tool.completed":
    case "tool.failed":
      return next;
    case "task.reasoning.delta":
    case "task.output.delta":
    case "team.message.completed":
      return next;
    case "session.reasoning.delta":
      return { ...next, reasoning: state.reasoning + event.delta };
    case "session.output.delta":
      return { ...next, output: state.output + event.delta };
    case "session.completed":
      return {
        ...next,
        lanes: { main: "complete", sidekick: next.lanes.sidekick },
        output: event.text,
        status: "complete",
        usage: event.usage,
      };
    case "session.failed":
      return {
        ...next,
        error: cleanErrorMessage(event.message),
        status: "failed",
      };
    case "context.compacted":
    case "plan.completed":
      return next;
  }
}

export function conversationMessages(state: FusionState): FusionMessage[] {
  const turns = [...state.history];
  const current = archiveCurrentTurn(state);
  if (current !== undefined) {
    turns.push(current);
  }
  return turns.flatMap((turn): FusionMessage[] =>
    turn.status === "complete" && turn.output !== ""
      ? [
          { role: "user", content: turn.prompt },
          { role: "assistant", content: turn.output },
        ]
      : [],
  );
}

function archiveCurrentTurn(state: FusionState): FusionTurn | undefined {
  if (
    state.prompt === "" ||
    (state.status !== "complete" && state.status !== "failed")
  ) {
    return undefined;
  }
  return {
    events: state.events,
    output: state.output,
    prompt: state.prompt,
    reasoning: state.reasoning,
    status: state.status,
    ...(state.error === undefined ? {} : { error: state.error }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  };
}

function cleanErrorMessage(message: string): string {
  return message.replace(ANSI_ESCAPE_SEQUENCE, "");
}
