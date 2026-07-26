# OpenClaw Execution Plan Timeline UI

Status: implemented

Baseline:

- OpenClaw Gateway: `v2026.6.11`
- Planning tool: experimental native `update_plan`
- Implementation date: 2026-07-26

## Product decision

Each valid `update_plan` call is displayed where it occurred in the assistant
message timeline, similar to a dedicated tool card. A later update creates
another card containing that invocation's complete snapshot. It does not
replace an input-area card or mutate an earlier card.

Execution plans are independent of Goal mode:

| Concept        | Authority                       | Presentation                            |
| -------------- | ------------------------------- | --------------------------------------- |
| Goal           | OpenClaw Goal lifecycle         | React `GoalStatusCard` above the prompt |
| Plan update    | OpenClaw `update_plan` ToolItem | Lit message timeline card               |
| Scheduled task | JustDo scheduler/OpenClaw cron  | Scheduled Tasks feature                 |

No Goal, Redux, SQLite, preload, IPC, bundled skill, custom MCP tool, or runtime
patch is used for plan updates.

## Protocol

Managed OpenClaw config enables the native tool:

```ts
tools: {
  experimental: {
    planTool: true,
  },
}
```

The accepted input is:

```ts
interface OpenClawUpdatePlanInput {
  explanation?: string;
  plan: Array<{
    step: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>;
}
```

`src/shared/openclaw/executionPlan.ts` owns total, side-effect-free validation.
It rejects empty plans, empty step text, unknown statuses, partial invalid
arrays, and plans containing more than one `in_progress` step. Optional
explanation and step text are trimmed; unknown fields are ignored.

The renderer reads only normalized `ToolItem.input`. It does not parse tool
output, assistant prose, Markdown task lists, thinking, or `TodoWrite`.

## Timeline projection

The canonical live reducer and persisted Gateway history both produce
`ToolItem` values. Existing history normalization already preserves call ID,
tool name, and structured input across:

- live tool start and completion events;
- standalone `tool_use` and `tool_result`;
- tool blocks inside assistant content;
- attached tool messages and Gateway envelopes;
- stringified structured input.

`projectTurnItems` and `projectPersistedTimeline` recognize a
case-insensitive exact `update_plan` name with valid input and emit a standalone
`plan-update` item. This creates a hard process-summary boundary, so the update
is visible without opening the generic Thinking/Tool disclosure. Invalid calls
remain ordinary ToolItems.

Each timeline card shows:

- localized "Update plan" / "更新计划" title;
- model-declared completed count;
- optional explanation;
- ordered step rows;
- distinct completed, in-progress, and pending markers;
- accessible localized status labels;
- running/failed/completed tool state;
- reduced-motion-safe activity styling.

The raw invocation remains the canonical ToolItem. Reloading Gateway history
reconstructs the same sequence of cards, and multiple calls are never merged.

## Files

| File                                                                 | Responsibility              |
| -------------------------------------------------------------------- | --------------------------- |
| `src/main/openclaw/config/openclawConfigSync.ts`                     | Enable native plan tool     |
| `src/shared/openclaw/executionPlan.ts`                               | Protocol model and parser   |
| `src/renderer/libs/openclaw-chat/model/project-turn-items.ts`        | Live projection             |
| `src/renderer/libs/openclaw-chat/model/project-history-timeline.ts`  | History projection          |
| `src/renderer/libs/openclaw-chat/components/active-turn-timeline.ts` | Timeline card markup        |
| `src/renderer/libs/openclaw-chat/components/justdo-chat.ts`          | Card styling                |
| `src/renderer/services/i18n/translations.ts`                         | Chinese and English strings |

## Validation

Automated coverage includes:

- valid and invalid protocol inputs;
- atomic rejection and the single-`in_progress` invariant;
- multiple live calls remaining separate;
- multiple persisted calls restoring in order;
- malformed calls retaining ordinary Tool rendering;
- card ordering, explanation, count, status styles, and always-visible markup;
- managed config preserving `planTool: true`.

Manual verification should use a non-trivial prompt with a model that supports
structured tool calls. Confirm that each update appears immediately, later
updates add new cards, process summaries still behave normally, and reopening
the session restores the same card sequence.
