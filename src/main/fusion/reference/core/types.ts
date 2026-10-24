import type { LanguageModel, ToolSet } from "ai";

export type AgentRole = "main" | "sidekick";
export type FusionModel = LanguageModel | string;
export type CodeLanguage = "javascript" | "python" | "typescript";
export type FusionReasoning =
  "provider-default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface SearchMatch {
  line: number;
  path: string;
  text: string;
}

export interface ExecutionEnvironment {
  close(): Promise<void>;
  editFile(
    path: string,
    oldText: string,
    newText: string,
  ): Promise<{ replacements: number }>;
  execute(command: string, args?: string[]): Promise<CommandResult>;
  executeShell(script: string): Promise<CommandResult>;
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  runCode(language: CodeLanguage, code: string): Promise<CommandResult>;
  search(query: string): Promise<SearchMatch[]>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface FusionMessage {
  content: string;
  role: "assistant" | "system" | "user";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentTurn {
  profile?: string;
  text: string;
  usage: TokenUsage;
}

export type AgentStreamPart =
  | { type: "reasoning-delta"; text: string }
  | { type: "text-delta"; text: string };

export type ToolActivityEvent =
  | {
      input: unknown;
      toolCallId: string;
      toolName: string;
      type: "started";
    }
  | {
      durationMs: number;
      output: unknown;
      toolCallId: string;
      toolName: string;
      type: "completed";
    }
  | {
      durationMs: number;
      error: string;
      toolCallId: string;
      toolName: string;
      type: "failed";
    };

export interface FusionPlan {
  complexity: number;
  mainTask: string;
  sidekickAssignments?: FusionSidekickAssignment[];
  sidekickTasks: string[];
}

export interface FusionSidekickAssignment {
  profile?: string;
  task: string;
}

export interface FusionWorkerProfile {
  description?: string;
  instructions: string;
  model?: string;
  name: string;
  tools?: string[];
}

export interface PlanRequest {
  context: FusionMessage[];
  model: FusionModel;
  prompt: string;
  reasoning?: FusionReasoning;
  signal?: AbortSignal;
  workerProfiles?: FusionWorkerProfile[];
}

export interface ExecuteRequest {
  activeTools?: string[];
  context: FusionMessage[];
  model: FusionModel;
  instructions?: string;
  onToolEvent?: (event: ToolActivityEvent) => void;
  onStreamPart?: (part: AgentStreamPart) => void;
  role: AgentRole;
  profile?: string;
  reasoning?: FusionReasoning;
  sessionId?: string;
  signal?: AbortSignal;
  task: string;
}

export interface SynthesisRequest {
  context: FusionMessage[];
  mainResult: AgentTurn;
  model: FusionModel;
  onToolEvent?: (event: ToolActivityEvent) => void;
  onStreamPart?: (part: AgentStreamPart) => void;
  prompt: string;
  reasoning?: FusionReasoning;
  sessionId?: string;
  sidekickResults: AgentTurn[];
  signal?: AbortSignal;
}

export interface CompactRequest {
  context: FusionMessage[];
  model: FusionModel;
  reasoning?: FusionReasoning;
  role: AgentRole;
  signal?: AbortSignal;
}

export interface AgentRunner {
  compact(request: CompactRequest): Promise<string>;
  execute(request: ExecuteRequest): Promise<AgentTurn>;
  plan(request: PlanRequest): Promise<FusionPlan>;
  synthesize(request: SynthesisRequest): Promise<AgentTurn>;
}

export interface SessionRecord {
  compactions: Record<AgentRole, number>;
  contexts: Record<AgentRole, FusionMessage[]>;
  createdAt: string;
  id: string;
  models?: { main: string; sidekick: string };
  prompt: string;
  sidekickFailures: number;
  updatedAt: string;
}

export interface SessionStore {
  append(id: string, role: AgentRole, message: FusionMessage): Promise<void>;
  compact(id: string, role: AgentRole, summary: string): Promise<void>;
  create(input: { prompt: string }): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | undefined>;
  update(
    id: string,
    update: Partial<Pick<SessionRecord, "models" | "sidekickFailures">>,
  ): Promise<void>;
}

export type FusionEvent =
  | { type: "team.message.completed"; sessionId: string; role: AgentRole; task: string; text: string; workerId?: string; interrupted?: boolean }
  | {
      type: "session.started";
      sessionId: string;
      models: { main: string; sidekick: string };
    }
  | { type: "plan.completed"; sessionId: string; plan: FusionPlan }
  | {
      type: "task.started";
      sessionId: string;
      role: AgentRole;
      task: string;
      model?: string;
      profile?: string;
      workerId?: string;
    }
  | {
      type: "task.completed";
      sessionId: string;
      role: AgentRole;
      task: string;
      text: string;
      profile?: string;
      workerId?: string;
    }
  | {
      type: "task.reasoning.delta";
      sessionId: string;
      role: AgentRole;
      task: string;
      delta: string;
      profile?: string;
      workerId?: string;
    }
  | {
      type: "task.output.delta";
      sessionId: string;
      role: AgentRole;
      task: string;
      delta: string;
      profile?: string;
      workerId?: string;
    }
  | {
      type: "task.failed";
      sessionId: string;
      role: AgentRole;
      task: string;
      message: string;
      profile?: string;
      workerId?: string;
    }
  | ({
      sessionId: string;
      role: AgentRole;
      task: string;
      workerId?: string;
    } & (
      | {
          input: unknown;
          toolCallId: string;
          toolName: string;
          type: "tool.started";
        }
      | {
          durationMs: number;
          output: unknown;
          toolCallId: string;
          toolName: string;
          type: "tool.completed";
        }
      | {
          durationMs: number;
          error: string;
          toolCallId: string;
          toolName: string;
          type: "tool.failed";
        }
    ))
  | { type: "context.compacted"; sessionId: string; role: AgentRole }
  | {
      type: "session.reasoning.delta";
      sessionId: string;
      delta: string;
    }
  | {
      type: "session.output.delta";
      sessionId: string;
      delta: string;
    }
  | {
      type: "session.completed";
      sessionId: string;
      text: string;
      usage: FusionUsage;
    }
  | { type: "session.failed"; sessionId: string; message: string };

export interface FusionUsage extends TokenUsage {
  totalTokens: number;
}

export interface FusionResult {
  models: { main: string; sidekick: string };
  sessionId: string;
  text: string;
  usage: FusionUsage;
  warnings: string[];
}

export interface FusionRunBudget {
  /** Maximum main and sidekick task executions. Planning and synthesis are not counted. */
  maxTurns?: number;
  /** Maximum observed input plus output tokens across task execution and synthesis. */
  maxTokens?: number;
  /** Maximum elapsed wall time for the run in milliseconds. */
  timeoutMs?: number;
}

export interface FusionRunRequest {
  budget?: FusionRunBudget;
  messages?: FusionMessage[];
  prompt: string;
  reasoning?: FusionReasoning;
  sessionId?: string;
  signal?: AbortSignal;
  workerProfiles?: FusionWorkerProfile[];
}

export interface WorkspaceToolOptions {
  additionalRoots?: string[];
  commandTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  root: string;
}

export type FusionToolSet = ToolSet;
