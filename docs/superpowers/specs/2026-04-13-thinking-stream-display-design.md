---
name: thinking-stream-display
description: Design for displaying OpenClaw thinking content in assistant messages
type: project
---

# Thinking Stream Display Feature Design

**Date**: 2026-04-13
**Project**: GucciAI
**Author**: Claude

## Overview

Add support for displaying OpenClaw model thinking content in the chat interface. Thinking content should be embedded at the top of each assistant message, collapsible by default, and streamed in real-time during model generation.

## Requirements

1. Thinking content displayed at the top of assistant messages
2. Collapsible/expandable via title bar icon
3. Default state: collapsed
4. Style: gray text, small font, no markdown rendering (Claude Code style)
5. Real-time streaming display when expanded during generation
6. Data layer and UI layer decoupled

## Architecture

### 1. Data Layer

**Type Definition Changes**

Location: `src/renderer/types/cowork.ts`

```typescript
export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
  thinkingContent?: string;  // NEW: Thinking content (accumulated during streaming)
}
```

**IPC Event Addition**

- New event: `cowork:stream:thinkingUpdate`
- Parameters: `{ sessionId: string; messageId: string; thinkingDelta: string }`

### 2. Backend Processing

Location: `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

**ActiveTurn State Extension**

```typescript
type ActiveTurn = {
  // ...existing fields
  currentThinkingMessageId: string | null;  // NEW
  currentThinkingContent: string;           // NEW
  thinkingStreamEnded: boolean;             // NEW
};
```

**New Method: handleAgentThinkingEvent**

Handles thinking stream events from OpenClaw:
- Each event contains `text` (full content) and `delta` (incremental)
- First thinking event: Create assistant message, initialize `currentThinkingContent`, send IPC
- Subsequent events: Use `delta` for incremental update, send `thinkingUpdate` IPC
- Stream ends when: (a) agent event stream changes to non-thinking, or (b) first text content arrives

**Modified Method: dispatchAgentEvent**

```typescript
private dispatchAgentEvent(sessionId: string, turn: ActiveTurn, agentPayload: AgentEventPayload): void {
  const stream = agentPayload.stream?.trim() ?? '';

  // NEW: Handle thinking stream
  if (stream === 'thinking') {
    this.handleAgentThinkingEvent(sessionId, turn, agentPayload.data);
    return;
  }

  // Existing logic for tool/tools/lifecycle...
}
```

**Fallback Logic**

When first text content arrives:
- If `currentThinkingMessageId` exists and `thinkingStreamEnded` is false
- Mark thinking as ended before starting normal reply

### 3. IPC Communication Layer

Location: `src/main/main.ts`

```typescript
// Forward thinking update to renderer
windows.forEach(win => {
  win.webContents.send('cowork:stream:thinkingUpdate', {
    sessionId,
    messageId,
    thinkingDelta,
  });
});
```

Location: `src/main/preload.ts`

```typescript
onStreamThinkingUpdate: (callback: (data: {
  sessionId: string;
  messageId: string;
  thinkingDelta: string;
}) => void) => {
  const handler = (_event: any, data: ...) => callback(data);
  ipcRenderer.on('cowork:stream:thinkingUpdate', handler);
  return () => ipcRenderer.removeListener('cowork:stream:thinkingUpdate', handler);
},
```

### 4. Frontend Service Layer

Location: `src/renderer/services/cowork.ts`

```typescript
private setupStreamListeners(): void {
  // Existing listeners...

  // NEW: Thinking update listener
  const thinkingUpdateCleanup = cowork.onStreamThinkingUpdate(
    ({ sessionId, messageId, thinkingDelta }) => {
      store.dispatch(updateMessageThinkingContent({
        sessionId,
        messageId,
        thinkingDelta,
      }));
    }
  );
  this.streamListenerCleanups.push(thinkingUpdateCleanup);
}
```

### 5. Redux Layer

Location: `src/renderer/store/slices/coworkSlice.ts`

**New Action**

```typescript
updateMessageThinkingContent: (state, action: PayloadAction<{
  sessionId: string;
  messageId: string;
  thinkingDelta: string;
}>) => {
  const session = state.sessions.find(s => s.id === action.payload.sessionId);
  const message = session?.messages.find(m => m.id === action.payload.messageId);
  if (message) {
    message.thinkingContent = (message.thinkingContent || '') + action.payload.thinkingDelta;
  }
},
```

### 6. UI Layer

Location: `src/renderer/components/cowork/CoworkSessionDetail.tsx`

**Modified Component: AssistantMessageItem**

```typescript
const AssistantMessageItem: React.FC<{...}> = ({ message, ... }) => {
  const hasThinking = message.thinkingContent && message.thinkingContent.length > 0;
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  return (
    <div className="relative">
      {/* Thinking block - embedded at top */}
      {hasThinking && (
        <ThinkingEmbedBlock
          content={message.thinkingContent}
          expanded={thinkingExpanded}
          onToggle={() => setThinkingExpanded(!thinkingExpanded)}
          isStreaming={message.metadata?.isStreaming && !message.content}
        />
      )}

      {/* Normal content */}
      {message.content && (
        <MarkdownContent content={displayContent} ... />
      )}

      {/* Copy button */}
      {showCopyButton && <CopyButton ... />}
    </div>
  );
};
```

**New Component: ThinkingEmbedBlock**

```typescript
const ThinkingEmbedBlock: React.FC<{
  content: string;
  expanded: boolean;
  onToggle: () => void;
  isStreaming?: boolean;
}> = ({ content, expanded, onToggle, isStreaming }) => {
  return (
    <div className="mb-2">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronIcon className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span>Thinking</span>
        {isStreaming && <TypingDots />}
      </button>

      {expanded && (
        <div className="mt-1.5 pl-4 text-xs text-muted-foreground whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  );
};
```

**Styling**

- Gray text (`text-muted-foreground`)
- Small font (`text-xs`)
- No markdown rendering
- Collapsible via chevron icon in title bar
- Streaming indicator when generating

### 7. Error Handling

- Thinking stream interruption: preserve accumulated content
- Multiple thinking blocks: merge into single field
- Long thinking content: optional truncation or scroll (future enhancement)

## Implementation Order

1. **Phase 1 - Data Layer**
   - Modify `CoworkMessage` type
   - Add Redux action for thinking update

2. **Phase 2 - IPC Layer**
   - Add `thinkingUpdate` IPC event
   - Update preload with listener

3. **Phase 3 - Backend**
   - Modify `ActiveTurn` state
   - Implement `handleAgentThinkingEvent`
   - Update `dispatchAgentEvent`
   - Add fallback logic

4. **Phase 4 - Frontend Service**
   - Add thinking update listener in `cowork.ts`

5. **Phase 5 - UI**
   - Create `ThinkingEmbedBlock` component
   - Modify `AssistantMessageItem` to embed thinking

6. **Phase 6 - Testing**
   - Verify streaming works with OpenClaw
   - Test collapse/expand behavior
   - Verify fallback logic

## Key Files to Modify

| File | Changes |
|------|---------|
| `src/renderer/types/cowork.ts` | Add `thinkingContent` field |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | Handle thinking stream events |
| `src/main/main.ts` | Forward thinking update IPC |
| `src/main/preload.ts` | Add `onStreamThinkingUpdate` |
| `src/renderer/services/cowork.ts` | Listen for thinking updates |
| `src/renderer/store/slices/coworkSlice.ts` | Add `updateMessageThinkingContent` action |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | Add `ThinkingEmbedBlock`, modify `AssistantMessageItem` |

## OpenClaw Event Format Reference

OpenClaw sends thinking events via `emitAgentEvent` with the following structure:

```typescript
{
  runId: string,
  stream: "thinking",
  data: {
    text: string,   // Full accumulated thinking content
    delta: string,  // New content since last event
  }
}
```

**Important Notes**:
- No explicit `thinking_start` / `thinking_delta` / `thinking_end` event types
- Each event contains both full text and incremental delta
- Thinking stream ends when: (a) event stream changes to another type, or (b) no more thinking events received after text content starts

## Why: User requested thinking display feature for OpenClaw models
## How to apply: Follow implementation order, start with data layer, end with UI testing