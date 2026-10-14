export type FusionHookEvent =
  "postTool" | "preTool" | "sessionEnd" | "sessionStart";

export interface FusionHookContext {
  error?: string;
  event?: FusionHookEvent;
  input?: unknown;
  output?: unknown;
  prompt?: string;
  role?: "main" | "sidekick";
  sessionId: string;
  task?: string;
  toolCallId?: string;
  toolName?: string;
}

export interface FusionHooks {
  run(event: FusionHookEvent, context: FusionHookContext): Promise<void>;
}

export interface CommandHookDefinition {
  command: string;
  event: FusionHookEvent;
  matcher?: string;
  timeoutMs?: number;
}

export interface HookCommandResult {
  exitCode: number;
  stderr?: string;
  stdout?: string;
}

export type HookCommandExecutor = (
  command: string,
  context: FusionHookContext & { event: FusionHookEvent },
  timeoutMs: number,
) => Promise<HookCommandResult>;

interface CommandHookRunnerOptions {
  definitions: CommandHookDefinition[];
  execute: HookCommandExecutor;
}

interface CompiledHook {
  definition: CommandHookDefinition;
  matcher?: RegExp;
}

export class CommandHookRunner implements FusionHooks {
  readonly #execute: HookCommandExecutor;
  readonly #hooks: CompiledHook[];

  constructor(options: CommandHookRunnerOptions) {
    this.#execute = options.execute;
    this.#hooks = options.definitions.map((definition) => ({
      definition: { ...definition },
      ...(definition.matcher === undefined
        ? {}
        : { matcher: compileMatcher(definition.matcher) }),
    }));
  }

  async run(event: FusionHookEvent, context: FusionHookContext): Promise<void> {
    for (const hook of this.#hooks) {
      if (hook.definition.event !== event) {
        continue;
      }
      if (
        hook.matcher !== undefined &&
        !hook.matcher.test(context.toolName ?? "")
      ) {
        continue;
      }
      const result = await this.#execute(
        hook.definition.command,
        { ...context, event },
        hook.definition.timeoutMs ?? 10_000,
      );
      if (result.exitCode !== 0) {
        const detail = result.stderr?.trim();
        throw new Error(
          `Hook ${hook.definition.command} exited with exit code ${String(result.exitCode)}${detail === undefined || detail === "" ? "" : `: ${detail}`}`,
        );
      }
    }
  }
}

function compileMatcher(value: string): RegExp {
  try {
    return new RegExp(value, "u");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid hook matcher ${value}: ${message}`);
  }
}
