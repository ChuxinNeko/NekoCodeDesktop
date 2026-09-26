# Pico5 live extension registries

Status: proposed merge input for `pico-v5.md`. This document is not normative
until its contracts are incorporated into that specification.

This proposal replaces Pico5's close-and-reopen extension reload path with the
smallest safe in-process mechanism:

> New work switches to the replacement immediately. Work already in progress
> remains pinned to the code and resources with which it started until it
> actually settles.

It covers tools, task kinds, and hooks. System sections, conversation listeners,
and arbitrary Chord service-provider reload are deliberately deferred.

## 1. Problem

The current Pico5 design treats Session-side extension code as part of one
Harness generation. Replacing a tool, hook, or task kind therefore requires the
host to close the Harness, join all invocations, reopen the same storage, and
resume from durable checkpoints.

That fallback is safe but unnecessarily disruptive. Changing one tool can
interrupt unrelated generations, tools, and child conversations.

Replacing callbacks directly in mutable maps is not safe either:

- one invocation can start with an old task kind and finish through new hooks;
- a failed facet activation can expose only part of its replacement;
- disposing an old facet can close resources still used by its callbacks;
- interrupting an effect merely because code changed creates an uncertain-effect
  recovery case;
- arbitrary JavaScript cannot be forcibly terminated in-process.

The required behavior is generation pinning, not callback mutation.

## 2. Scope and non-goals

This proposal provides:

- application-owned extension registries passed to `Harness.open()`;
- one atomic contribution generation per extension owner;
- per-key lookup for tools, task kinds, and hooks;
- gapless replacement for new work;
- generation pinning for work already in progress;
- automatic Chord facet registration cleanup;
- compatible task-kind handover at normal durable phase boundaries;
- observable draining of old generations.

It does not provide:

- forced termination of arbitrary JavaScript;
- a deadline after which work is declared complete;
- detached or fabricated callback settlement;
- cancellation merely because an implementation was replaced;
- `aroundTool` or `aroundPhase` wrappers;
- transparent wrapper unrolling;
- cross-owner overrides of named tools or task kinds;
- atomic replacement of several independent extension owners;
- hot replacement of the Harness core, storage, or the Harness Chord provider;
- general generation pinning for arbitrary Chord service graphs.

Harness-core and storage changes continue to use close and reopen. Process or
worker termination remains the escape for non-cooperative code.

## 3. Terms and invariants

- An **owner** is the stable identity of one extension contributor.
- A **generation** is one immutable complete contribution set published by an
  owner.
- A **snapshot** is an invocation-local registry view. It lazily pins owner
  generations as they are first touched.
- A **pin** keeps one retired generation and its facet resources alive.
- **Cutover** atomically publishes a candidate generation and retires its
  predecessor.
- **Drainage** occurs when a retired generation has no pins.
- A **parked facet** has retired its contributions but retains its ordinary
  resources until its generation drains.

Required invariants:

1. Every execution of registered code belongs to one pinned owner generation.
2. New independent invocations never acquire a retired generation.
3. Once an invocation pins owner `X`, every later lookup for `X` in that
   invocation, including a nested tool or hook call, uses the same generation
   and sees the same missing contributions.
4. Replacement never signals or interrupts existing work.
5. A retired generation admits no new independent acquisition or contribution;
   existing pinned invocations retain access to it.
6. Facet resources outlive every invocation using that facet generation.
7. Failed candidate activation publishes no contribution and changes no task.
8. A task changes implementation only after its current phase handler and every
   accepted invocation-owned operation have settled.
9. No successor invocation runs concurrently with its predecessor for the same
   task.
10. Storage-admitted commits settle before task handover or storage close.

## 4. Registry surface

The application constructs one registry set and passes it to the Harness:

```ts
type HookHandler = (...args: never[]) => unknown;

type HookLocation = {
  readonly conversationId: Id;
  readonly ownershipAncestors: readonly Id[];
};

type HookContribution = {
  readonly task: string;
  readonly hook: string;
  readonly handler: HookHandler;
  readonly scope?: {
    readonly conversationId: Id;
    readonly subtree?: boolean;
  };
};

type ExtensionContributions = {
  readonly tools?: readonly ToolRegistration[];
  readonly taskKinds?: readonly AnyTask[];
  readonly hooks?: readonly HookContribution[];
};

type ExtensionGeneration = {
  readonly owner: string;
  readonly sequence: number;
  readonly state: "current" | "retired" | "drained";
  readonly pins: number;
  retire(): void;
  readonly drained: Promise<void>;
};

interface ExtensionSnapshot {
  tool(name: string): ToolRegistration | undefined;
  taskKind(name: string): AnyTask | undefined;
  hooks(task: string, hook: string, at: HookLocation): readonly HookHandler[];
  release(): void;
}

interface ExtensionRegistries {
  replace(
    owner: string,
    contributions: ExtensionContributions,
  ): ExtensionGeneration;

  /** Harness-facing read surface; application code does not call this. */
  snapshot(): ExtensionSnapshot;
  subscribe(listener: () => void): () => void;
}

type HarnessOptions = {
  readonly models: Models;
  readonly registries: ExtensionRegistries;
  // Existing options not replaced by this proposal remain here.
};
```

`replace()` performs all validation before publication. Publication is
synchronous and invokes no extension callback.

Built-in tools and task kinds remain Harness-core tables outside the extension
registries. They change only across a close/reopen core generation and are never
pinned, drained, or superseded through this API. `replace()` rejects an extension
candidate whose tool or task-kind name collides with a built-in. Harness lookup
combines the immutable core table with the extension snapshot.

One owner has at most one current generation. Replacing that owner atomically:

1. publishes the candidate complete contribution set;
2. makes it current for new snapshots;
3. retires the predecessor;
4. notifies registry subscribers.

The predecessor remains usable through existing pins. Calling its exact
`retire()` again is idempotent and never withdraws its successor.

### 4.1 Names and collisions

Tool names and task-kind names are unique across current owners. A candidate that
collides with another owner rejects before publication. Same-owner replacement is
allowed and gapless.

Hooks are additive across owners. Their existing hook-specific composition and
ordinary-error rules remain defined by Pico5 section 7.1. Hook order is stable
owner order followed by declaration order within that owner's generation; an
owner reload does not move that owner's slot.

Cross-owner overrides are not supported initially. They can be added later as an
explicit host policy rather than warning-only executable substitution.

### 4.2 Internal snapshots

The Harness opens one internal registry snapshot for each scheduler task
invocation. Tool execution, request preparation, and every hook question nested
inside that invocation share it. Nested runtime operations inherit its existing
owner pins rather than opening an unrelated view. An independent host operation
may open its own snapshot. Application code does not manage snapshots or pins.

A snapshot lazily pins owners:

```text
create snapshot
first lookup resolved to owner A → pin A's current generation
later lookup for owner A         → use that pinned generation
first lookup resolved to owner B → pin B's then-current generation
invocation fully settles         → release A and B
```

Owners never touched are not pinned. Several retired generations of one owner may
drain concurrently.

A snapshot releases its pins only after:

- the callback's real promise settles;
- accepted invocation-bound runtime operations settle;
- invocation-owned watches stop and their active callbacks settle.

The registry never substitutes its own promise, detaches a callback, or claims
that a callback ended before its real settlement.

## 5. Registry readers

The Harness owns composition. The registries only provide generation-consistent
lookup.

### 5.1 Tools

Request preparation resolves declarations through the generation invocation's
snapshot using the existing durable active-tool names. A missing active name
retains Pico5's `missing_active_tool` behavior.

A tool task resolves and pins one implementation before execution-schema
validation and durable effect-intent admission. That one definition supplies its
schema, replay policy, and `execute()` function and remains pinned through task
settlement. If the exact name is no longer registered although the stored
`pi.system` history proves it was offered, the task appends an error tool result:

```ts
{ code: "tool_unavailable" }
```

The turn continues so the model can react.

Arguments must satisfy both the declaration offered to the model and the current
pinned implementation's schema. An incompatible replacement produces an error
tool result without executing replacement code.

Replacing a tool while it runs does not interrupt it. Its result is produced by
the implementation it pinned. The next independent tool invocation uses the
replacement.

### 5.2 Hooks

Each hook question captures its complete applicable handler list from the
scheduler invocation's shared snapshot before running its first handler.
Replacement cannot change the remaining chain midway.

A generation preparation attempt also uses that invocation snapshot. Registry
movement alone does not restart preparation: the exact pinned declarations and
handlers remain authoritative for that attempt, and the next independent
invocation sees replacements. Existing retry rules for durable configuration or
document revision changes remain, but those retries reuse the pinned extension
snapshot.

Conversation subtree matching uses the conversation ownership chain, not the
history-parent chain.

Existing Pico5 composition and error rules remain unchanged. This proposal adds
no wrapper hooks and no special revocation errors because ordinary replacement
never signals a handler.

`Conversation.hooks()` may remain as a convenience that publishes one scoped
hook-only owner generation and retires it through the returned disposer.

### 5.3 Task kinds

A scheduler invocation pins one task kind for its complete lifetime, including
successive phase handlers until a compatible handover boundary is reached.
Running tasks are never migrated in place.

## 6. Task-kind replacement

### 6.1 Continuation contract

Every successful, progress-making phase-handler settlement is already required
to leave a complete durable checkpoint. Live replacement strengthens that rule:

> A normal phase boundary is resumable from durable task state, documents, and
> durably identified external operations. Continuation does not depend on the
> retiring invocation's local variables or unfinished untracked work.

Registering the same task version is an explicit promise that persisted input,
checkpoint, memos, and continuation semantics remain compatible.

A higher version must provide `migrate()`. Its successful migration is the
compatibility proof for input and checkpoint. Memos pass through unchanged in
this initial design. A replacement that changes memo meaning is incompatible and
must not claim takeover compatibility.

Task-document migration remains access-driven and separate.

### 6.2 Normal automatic handover

Replacement never interrupts a phase handler. After one handler settles, the
scheduler applies existing rules first:

1. terminal task;
2. Session closing;
3. durable abort mark;
4. uncaught error;
5. no durable progress.

Only an ordinary continuation boundary is eligible for handover.

If the invocation's pinned kind generation is still current, execution continues
normally.

If it was superseded:

- the same task version is eligible by declaration;
- a higher version is eligible only when it provides `migrate()`;
- no current kind of that name is incompatible;
- an older current version is incompatible;
- a higher version without migration is incompatible.

Eligibility does not run migration as a preflight. Actual migration runs later in
the successor's reservation transaction against the latest drained checkpoint.
Migration failure then leaves the task pending and blocked without modifying its
durable payload.

For an eligible successor, the Harness:

1. ends the old invocation and rejects further invocation-bound operations;
2. stops its owned watches;
3. joins watch callbacks and accepted runtime operations;
4. lets storage-admitted commits settle normally;
5. rereads the task on the Session line and reapplies terminal, closing, abort,
   error, and no-progress precedence;
6. only for an ordinary continuation, persists the task as `pending`, preserving
   its latest checkpoint, memos, and abort mark;
7. releases the old generation pin.

The successor is a fresh invocation. Reservation selects and pins the current
kind. If migration is required, migration and `pending → running` commit
atomically before dispatch.

No public `requestTakeover()` API is needed. A handler that never settles never
transfers.

### 6.3 Incompatible replacement

If the current kind is incompatible, the task continues under its pinned old
generation and reports that condition once per task and replacement generation.
Handover is reconsidered at its next normal boundary.

This keeps useful work running rather than stranding it merely because an
incompatible candidate was published. The old facet remains parked while the pin
exists.

### 6.4 Reservation and stalled tasks

Every invocation start, including a fresh abort invocation, resolves the kind
through a new snapshot.

```text
kind missing
  → pending, blocked: missing_kind

stored version newer than current kind
  → pending, blocked: kind_too_old

stored version older than current kind
  → run pure migrate(input, checkpoint, storedVersion)
  → failure: pending, blocked: migration_failed
  → success: commit migrated input/checkpoint/version + running atomically

equal version
  → commit running
```

A live Session never automatically terminalizes a task solely because registry
code is missing or incompatible. A blocked task preserves its abort mark, remains
live, continues to block ordinary idle waits, and is retried when
`ExtensionRegistries` changes. The blocked reason and both versions are exposed
as derived task availability, not persisted as a new task state.

Open-time reconciliation changes surviving `running` tasks to `pending` but does
not orphan unknown or unmigratable kinds. The same reservation rules handle them
as temporarily blocked, so extension publication may occur before or after
`Harness.open()` without destroying work. Permanent extension removal requires
an explicit host operation:

```ts
orphanTask(
  id: Id,
  context: Context,
): Promise<"orphaned" | "terminal" | "not_blocked">;
```

It terminalizes a selected blocked task as `orphaned` and performs the existing
submission, turn-control, task-document, and diagnostic cleanup atomically.
Merely opening the Harness never makes that irreversible decision.

`Conversation.abort()` and `waitForIdle()` remain pending while a non-background
task is blocked. `orphanTask()` is the escape and may be called while either wait
is pending.

## 7. Chord facet integration

Facet authors should not receive or retain registration disposers. The Chord host
provides one local consumer-bound extension service. Its methods stage the
consumer facet's complete contribution set.

Conceptually:

```ts
setup(env) {
  const extensions = env.use(Extensions);

  env.onActivate(() => {
    extensions.tool(grep);
    extensions.taskKind(indexTask);
    extensions.hooks("tool", { beforeTool, afterTool });
  });
}
```

The service implementation knows the consuming facet's stable owner ID and
lifecycle. Registration ownership therefore cannot be forgotten.

### 7.1 Candidate activation

A candidate facet generation stages contributions during activation. They remain
invisible until candidate activation succeeds and every named collision is
validated. Acquiring the guarded service handle during setup does not publish or
invoke it.

At successful cutover, Chord calls one publication closure. That closure invokes
`ExtensionRegistries.replace(owner, stagedContributions)`. Failed candidate
activation discards the staging area and publishes nothing.

After cutover:

- new Harness snapshots acquire the candidate generation;
- old snapshots retain the predecessor;
- the predecessor's contribution capability is sealed;
- late registration from the predecessor rejects before changing a registry.

### 7.2 Retirement barrier

Cutover retires the predecessor generation immediately but does not dispose the
predecessor facet's ordinary resources.

Chord parks the old facet record. Ordinary resource disposal begins only after
all of that generation's registry pins drain. This protects sockets, timers,
subscriptions, stable dependency handles, and mutable service objects still used
by old callbacks. Parked dependency handles remain usable until drainage, and
host shutdown joins parked records before disposing those stable providers.

Initially, hot-reloadable contribution facets may depend only on stable
providers. Pinning or rebinding arbitrary provider generations is deferred.

`reload()` resolves after successful activation, publication, and predecessor
retirement. It does not mean the predecessor has drained or been disposed.
Retirement status and pin count remain observable for diagnostics.

Host shutdown joins both active and parked records. Non-cooperative work can
therefore prevent graceful shutdown from completing.

### 7.3 Minimum Chord lifecycle capability

The exact Chord API may follow its existing naming, but it must support these
semantics for local consumer-bound services:

1. create one guarded service view per consuming facet generation;
2. stage contributions until successful activation cutover;
3. synchronously retire the published contribution generation at replacement or
   unmount;
4. receive its `drained` promise as a retirement barrier;
5. park the old facet record until the barrier settles;
6. only then run ordinary facet disposers and release the old bundle.

The Harness extension provider itself remains stable and is not hot reloaded in
this first version. General provider replacement and transitive dependency
pinning remain outside this proposal.

## 8. Non-cooperative work and close

An invocation that never settles keeps its pinned generation and facet resources
alive. New work still uses the current replacement, so ordinary reload is not
blocked.

The registry does not pretend the old invocation stopped. It does not release
resources, write a fabricated interruption result, or permit a successor for the
same task to run concurrently.

Harness close retains Pico5's existing semantics:

1. seal mutation admission and task reservation;
2. signal active invocations and stop watches;
3. await invocations, watch callbacks, and admitted storage commits;
4. close sources and storage.

Close may remain pending on non-cooperative work. The safe operational fallback
is terminating the owning worker or process and reopening from durable state.
Old and new Harness instances must never own the same Session concurrently.

## 9. Resolved policy choices

This proposal resolves the recovered handoff's open decisions as follows:

1. **Deadlines:** none. Replacement is synchronous; real work drains
   asynchronously. Graceful close remains unbounded.
2. **Same-name contributions:** same-owner replacement is allowed; cross-owner
   named tool/task collisions reject; hooks are additive.
3. **Blocked tasks:** remain durable `pending`; availability is derived and
   visible; as live non-background tasks they continue to block ordinary idle
   waits until code returns or the host explicitly orphans them.
4. **System sections:** remain on the existing Pico5 surface for now.
5. **Revocation errors:** none are added because replacement does not cancel
   callbacks.
6. **Conversation-scoped hooks:** live until their explicit owner generation is
   retired. Collapse and reset do not retire them.
7. **Memos:** preserved unchanged. Memo transformation is deferred and a version
   change requiring it is incompatible.

## 10. Required tests

### Registry and snapshots

- Same-owner replacement has no lookup gap.
- Cross-owner and built-in tool/task-kind collisions reject before publication.
- An old generation's `retire()` cannot withdraw its successor.
- One invocation uses one coherent generation for every contribution from an
  owner, including a missing contribution.
- Separate owners are pinned lazily and released after real invocation
  settlement.
- Several retired generations of one owner may drain independently.

### Tools and hooks

- A tool replaced mid-call finishes once under its old implementation; the next
  call uses the replacement.
- A removed execution-time tool produces `tool_unavailable` and the turn
  continues.
- Incompatible current arguments never enter replacement tool code.
- A hook chain captured before replacement completes under its captured owner
  generations and existing composition rules.
- Scoped hooks follow ownership ancestry rather than history ancestry.

### Tasks

- Same-version task replacement transfers only after a normal progress boundary.
- A version bump migrates and reserves atomically.
- Migration failure leaves durable input, checkpoint, memos, and version
  unchanged and leaves the task visibly blocked.
- Terminal, close, abort, error, and no-progress rules take precedence over
  replacement.
- An incompatible replacement lets the old pinned kind continue and reports
  once.
- A non-settling handler never transfers and prevents its generation from
  draining.
- No successor invocation overlaps its predecessor.
- Registering a missing compatible kind wakes the scheduler.
- Reopen with a missing kind blocks rather than orphaning the task; conversation
  abort and idle waits remain pending until an explicit host orphan operation
  performs the complete terminal cleanup.
- A fresh abort invocation applies the same compatibility gate.

### Chord lifecycle

- Failed candidate activation publishes nothing.
- Successful reload returns after cutover without waiting for drainage.
- New work uses the candidate while old work retains all predecessor resources.
- Late predecessor registration rejects without leaking a contribution.
- Facet authors need no registration disposer.
- Ordinary facet disposal occurs only after registry drainage.
- Host shutdown joins parked records.

### Storage and close

- Accepted runtime operations and storage commits settle before handover.
- Invocation-bound APIs reject after invocation end.
- Close never closes storage beneath an admitted commit.
- Forced process restart recovers from the latest durable checkpoint without
  relying on process-local registry generations.

## 11. Normative integration map

If adopted, merge the contract into `pico-v5.md` coherently rather than making
implementers combine two normative documents:

- **§2.2:** pass `ExtensionRegistries` through `HarnessOptions`; remove Harness
  tool/task registration ownership; retain existing section/listener surfaces.
- **§2.2 and §5.4:** replace automatic open-time unknown-kind orphaning with
  derived blocked availability and an explicit host orphan operation.
- **§5.1 and §5.4:** pin task kinds per invocation; add compatible boundary
  handover and reservation-time migration.
- **§7.1 and §7.2:** define inherited hook snapshots and tool implementation
  pinning before validation and intent admission.
- **§7.3:** retain document/configuration revision retries but remove registry
  movement as a retry trigger within one pinned generation invocation.
- **§7.4:** replace close/reopen for ordinary extension changes with live
  owner-generation replacement; retain close/reopen for core and storage.
- **§9.2:** include invocation-owned watch drainage in pin release and handover.
- **§13:** remove the non-goal excluding in-process replacement of Session-side
  extension implementations, while retaining the process-isolation caveat.
- **Chord facet specification:** add candidate staging and retirement barriers for
  the stable Harness extension service.

After those normative edits land, this file may remain as rationale or be
removed to avoid two sources of truth.
