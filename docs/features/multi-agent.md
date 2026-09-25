# Persistent assistants and model-driven collaboration

Current activation: persistent peer collaboration is provided by the optional
`agent-team` extension (disabled by default). Enable it in Extensions to expose
its bundled skill, tools and native-send hooks. Ordinary turns receive no
automatic roster or collaboration instructions. Disabling it retains all
assistant profiles and historical Graph/message views; receipt reads belong to
Runtime Services.

## Current behavior

Users create and edit persistent assistants in **Settings → Assistants**, including
native AGENTS.md, SOUL.md and IDENTITY.md. Only main receives user conversations;
there is no home recipient selector, assistant session filter, direct peer-chat
entry point or manual Handoff action.

Manual profile saves serialize product metadata and managed configuration sync,
verify Gateway visibility, and roll back failed changes. Model-driven creation
uses `assistants_create`, backed by native `agents.create/update` and
`agents.files` APIs; incomplete creations remain disabled for retry. Both paths
use the managed profile roster, and empty model settings inherit the app default.

Persistent role files live under `stateDir/agent-workspaces/<agentId>`; execution
uses the task project directory. Users do not have to choose a workspace for each
assistant. The native runtime owns role files and message transcripts; the app
stores profile, task membership and delivery metadata only.

The model prepares task members with `task_assistants`, then communicates through
native `sessions_send`. Each task appears as one main conversation in the sidebar.
The collaboration tab shows the member graph and exchanges; selecting a pair
shows both directions in time order, and selecting a member opens its native
history with incoming peer identities. A persistent Collaboration button in the
conversation toolbar, next to Subtasks, reopens the graph overview even after
the collaboration tab is closed or a historical conversation is reopened.
Subagent executions remain distinct.

The task currently allows up to 12 members. Exchange bodies are resolved through
native receipt indexes in batches of at most 16; search and virtual scrolling
operate on the resulting renderer projection. See the maintained architecture in
[the cowork system](../architecture/04-cowork-system.md) and
[chat rendering](../architecture/15-chat-rendering.md).

## Assistant management experience

Settings presents a searchable roster with enabled/disabled filters and a profile
editor. Initial load selects main when available; later roster refreshes preserve
unsaved edits. New-role presets populate name and responsibilities only;
they do not silently replace native role files. Duplicate profile copies persisted
name, description and model into an unsaved draft, with a new identity on
save. It never copies role files, memory or transcripts. The settings page uses
name initials for visual identification and exposes no avatar controls.

Profile saves display the canonical metadata returned by the backend without
discarding unsaved role-file edits. Profile and role-file saves remain explicit
and separate. Role-file tabs retain native conflict detection, support reload
after confirmation, and show character
limits. Switching profiles, files or leaving the page protects unsaved changes.
Main cannot be disabled. There is no direct assistant conversation entry point.

Main has no assistant-level model selector. Desktop, browser and integration
conversations inherit the application default unless the session has an explicit
model choice. Legacy main profile models do not influence the composer, new
sessions or Gateway config; choosing a main model or saving its profile clears
that obsolete override. Specialist assistants retain independent model settings.

### Delete an assistant

The profile header offers deletion for non-main, non-default assistants. The
confirmation describes the retained history and role files. Active native work
blocks deletion. Deleted profiles disappear from Settings and cannot receive
product task invitations or be edited, while historical graphs keep their names.
The scheduled-task skill collection review card excludes deleted assistants from
its current members, search and aggregate status. Native jobs and historical
results remain intact; this display filter does not revoke native execution.
The native profile is retained for transcript ownership; this does not invoke
OpenClaw's destructive agent deletion or delete user files. Recreating the same
name creates a distinct assistant. Retrying an interrupted creation for a deleted
identity is rejected before any native profile or role-file writes. See the
deletion contract in
[Data storage](../architecture/10-data-storage.md).

## Code and verification boundaries

Profile metadata, task membership and native execution have separate owners.
`src/main/ipc/cowork/collaboration.ts` prepares task members and validates native
send admission; `src/main/data/collaborationStore.ts` persists only routing and
receipt metadata. The optional `openclaw-extensions/agent-team/` extension owns
tools and send hooks; `openclaw-extensions/runtime-services/collaboration-history.ts`
keeps history readable when that extension is disabled.

The role editor performs conflict checks before native writes, not atomic
compare-and-swap against external editors. Idle checks are observations, not
locks against all external clients. Shared project files have no automatic
per-member worktree isolation.

For lifecycle, stop/delete behavior, limits and test entry points, see
[peer collaboration](multi-agent-collaboration.md). Early profile selectors,
handoff flows and dated validation results are preserved in the
[historical implementation record](../archive/assistant-profiles-early-implementation.md);
they are not current operating instructions.
