# AI team

Open **AI team** in the title bar or app rail for the independent workspace.
IDE mode also has an activity-bar entry; **Settings → AI team → Open team overview**
provides another route. It is also
available through WebUI. The existing Team strategy in the composer continues
to work; both surfaces use the same saved roster and PI execution engine.

## Team workspace

- **Overview:** member cards, Main status, model, access, live work and recent
  activity. Stop an individual member without selecting its PI session.
- **Conversations:** persistent private chats and named groups. Each has a
  working folder, its own model, transcript and execution lifetime. Changing
  folders starts a new PI session; old transcripts remain in the normal sidebar.
  Replies are saved per model message: an opening reply stays in place while each
  hand-off appears in its own sender-labelled bubble. Member reports and closing
  replies are appended in order, and completed messages survive reopening. Live
  typing updates only its current bubble; run status is displayed separately.
- **Groups:** choose members, admin, notice, and either admin coordination or
  everyone replying. `@Name` and `@all` override the default routing. The notice
  and group memory are provided to each member. Groups run independently.
- **Memory:** view, search, add, edit and delete team, member and group memories.
  Relevant memories are supplied again on subsequent tasks and after restart.
- **Members & settings:** maintain profiles, avatars, models and access, and grant
  additional members Main status. The default admin always has Main rights.

Chief can now create specialists itself and delegate to them **in the same turn**,
including when Chief was initially the only member. Created members are saved
to app preferences and appear in the workspace immediately. Inside a group,
new members are added to that group. Deleting members and granting Main status
remain user actions. Removing a member reconciles affected groups and stops its
active work; deleting a group does not delete the underlying PI transcript.

### Agent tools and permissions

| Tools | Behavior |
| --- | --- |
| `list_bots`, `list_models` | Inspect the live roster, running work, accessible groups and configured models. |
| `create_bot` | Main members create persistent specialists; new members inherit the creator's model unless specified. |
| `update_bot` | Members edit themselves; Main members may edit other profiles. Privilege changes and deletion are excluded. |
| `team_assign`, `message_bot` | Assign work or ask a teammate; receive its report. Group work stays within group membership. Cycles, duplicate concurrent actors and exhausted budgets are refused. |
| `stop_bot` | Stop yourself; Main members may also stop teammates. The workspace can stop one member or the entire conversation. |
| `create_group`, `update_group` | Create groups; only Main members or the group admin can edit an existing group. |
| `post_to_group` | Start work in another accessible group; inspect its asynchronous results with `read_group_chat`. |
| `read_own_chat`, `read_group_chat`, `search_chats` | Retrieve private/group messages with access restricted by membership. |
| `remember`, `recall`, `forget` | Persist and search memories. Members read others' personal memory; only its owner or a Main member may edit it. Team memory is writable by Main members. Group members share group memory. |

Conversation metadata, messages, memories and work records are stored atomically
in `team-workspace.json` in the application's data directory. Interrupted work is
marked stopped after restart. Each conversation binds to its own ordinary PI
session, so the full transcript and existing approval UI remain available through
**Full transcript**. Team actors support automatic context compaction. Explicit
memory and recent conversation reports restore continuity when actors reopen.

This is a native PI/React adaptation of DS Bot's team capabilities. In particular,
`message_bot` returns a report within the calling PI tool, while posting to another
group starts an independent run. It does not import DS Bot's DSH runtime or its
separate desktop app, provider installers, connector/secrets system, per-Bot browser
containers, schedule UI, voice, or generated view cards. Those are separate app
subsystems, rather than implemented team parity. See `NOTICE` and
`licenses/DeepSeek-Bot-LICENSE.txt` for attribution.

## Composer strategy

The AI team is a third engine strategy (`strategy: "team"`) next to Fusion's
`delegate` and `parallel`. Pick **Team** in the composer's model menu; configure
it in **Settings → AI team**.

The idea comes from [DS Bot](https://github.com/Fei2411/DeepSeek-Bot)
(Apache-2.0): bots with a name, role, own instructions and model talk in a group
chat moderated by an admin. NekoCode keeps that conversation model and runs every
member as a coding agent in the open project.

## How a message is routed

| Message | Who answers |
| --- | --- |
| Plain text | The **admin**. It answers small things itself or hands work to members with the `team_assign` tool, reads their reports, follows up if needed and gives one final answer. |
| `@Name …` | That member directly (several `@Name`s: each answers, replies are joined). |
| `@all …` | Every member, admin included. |
| `@Admin … @Coder …` | Stays with the admin, who may delegate to the named member. |

Members report back to whoever assigned the task. With **Members can delegate**
enabled, a member may pass part of its task to another member (one level deep;
never back to the admin).

## In the chat

A team run is drawn under your message as a group chat, QQ-style: each message
has the sender's avatar and name (role, admin tag) on the left and a bubble on the
right. The admin's notes and its hand-offs (`@Coder <task>`) come first, then each
member's bubble with its tool calls (name + path/command, live status), its report,
and typing dots while it works. Consecutive messages from one member share one
avatar. The final answer is the bot's last message too: the admin's (or, for a
direct `@Name`, that member's) bubble holds it, with the usual copy/fork actions
under it; when several members were addressed directly their bubbles hold the
replies and the joined copy is not repeated. The Fusion inspector above the
composer is not shown for team runs.

Each finished run is saved on the session as a small `nekocode.team.thread.v1`
entry (the projected messages, not the token stream), so the group chat comes
back when the chat is reopened, and forks keep the threads of their branch. A run
that was stopped is saved with its unfinished messages marked failed. Until the
entry is written the live run is shown (with the final answer's sender known as
soon as the answer is on the transcript), so the end of a run does not flicker.

## Members

| Field | Meaning |
| --- | --- |
| Name | Used for `@Name`; 1–32 letters, digits, `_`, `-`; unique; `all` is reserved. |
| Role | Short label shown to the rest of the team, e.g. "Frontend engineer". |
| Instructions | The member's own system instructions. |
| Model | A `provider/model`, or *Follow chat model* (the model selected when Team was picked). |
| Thinking | Thinking level for that member. |
| Access | *Full access* uses the normal tools; *Read-only* limits it to `read`, `grep`, `find`, `ls`. |
| Avatar | A Grok-style bot face: a soft coloured shape with two slanted eyes that blink now and then (off with reduced motion). Shape `orb` / `pyramid` / `gem`, colour `teal` / `orange` / `indigo` / `violet` / `blue` / `coral`. Defaults: Chief orb·teal, Coder pyramid·indigo, Reviewer gem·violet; members without a choice get a stable one from their id, and the team itself shows the members huddled together. Changing it keeps the member's memory. |

Team settings: **Admin**, **Run assignments in parallel** (several tasks of one
`team_assign` call run at the same time — the admin is told to give them disjoint
files), **Members can delegate**, and **Hand-offs per message** (a budget across
the whole team for one user message, to bound cost).

Settings are read live: changes apply from the next message. Each member is one
long-lived actor per chat, so it remembers its earlier tasks and replies; changing
its role, model, instructions or the roster gives it a fresh actor. Resetting or
closing the chat releases all of them.

## Implementation

- `src/shared/team.ts` — types, validation, `DEFAULT_TEAM`, `@mention` parsing.
- `src/main/team-settings.ts` — live access to the `team` app preference.
- `src/main/fusion/team-engine.ts` — `FusionTeamEngine`: routing, `team_assign`,
  persistent member actors, events for the Fusion timeline.
- `src/main/fusion/engine-runtime.ts` — keeps one team engine per chat for
  `strategy: "team"`.
- `src/shared/team-thread.ts` — projects the run's events into chat messages.
- Renderer: `components/settings/TeamSettings.tsx`, `components/chat/TeamPicker.tsx`, `components/team/TeamAvatar.tsx`, `components/team/TeamThread.tsx` (shown by `Transcript.tsx`).
- Tests: `test/main/fusion-team-integration.test.ts`, `test/shared/team-thread.test.ts`.
