# Thinking Stream Display Implementation

> **历史参考**：本文档描述 v2026.4 时期基于 IPC 的 Thinking Stream 实现。自 v2026.6 起，Thinking content 已改为通过 Lit `<justdo-chat>` 管道直接由 Gateway WebSocket 渲染，不再经过 Redux + IPC 路径。请参见 [15-chat-rendering.md](../architecture/15-chat-rendering.md) 了解当前架构。

## Overview

This document describes the final implementation of the "Thinking Stream Display" feature for OpenClaw models in JustDo. The feature allows real-time display of model thinking/reasoning content during assistant message generation.

**Implementation Date**: 2026-04-14
**Key Commits**:
- `4f48f8d`: feat: implement real-time thinking stream display for OpenClaw
- `1176a7f`: feat: add global thinking collapse toggle and adjust code font size
- `2eba092`: fix: persist thinking content to database for session reload

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           OpenClaw Runtime                                   │
│  (pi-embedded-subscribe.ts sends thinking stream events via emitAgentEvent) │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ emitAgentEvent({ stream: "thinking", data: { text, delta } })
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       OpenClawRuntimeAdapter                                 │
│  handleAgentThinkingEvent() → emit('thinkingUpdate', sessionId, messageId,  │
│                                      thinkingDelta)                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ thinkingUpdate event
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CoworkEngineRouter                                     │
│  Forward thinkingUpdate event to main process                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ thinkingUpdate event
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Main Process                                       │
│  main.ts → win.webContents.send('cowork:stream:thinkingUpdate', {...})      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ IPC: cowork:stream:thinkingUpdate
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Renderer Process                                     │
│  preload.ts → onStreamThinkingUpdate listener                                │
│  cowork.ts → dispatch(updateMessageThinkingContent)                          │
│  coworkSlice.ts → update thinkingContent in Redux store                      │
│  CoworkSessionDetail.tsx → ThinkingStreamBlock component                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Implementation Details

### 1. OpenClaw Patch

**File**: `scripts/patches/v2026.4.11/openclaw-thinking-stream.patch`

The patch modifies OpenClaw's `pi-embedded-subscribe.ts` to:

1. **Enable streamReasoning unconditionally** (when `reasoningMode === "stream"`):
   ```typescript
   // Before: Required onReasoningStream callback
   streamReasoning: reasoningMode === "stream" && typeof params.onReasoningStream === "function",
   
   // After: Always enable when reasoningMode is "stream"
   streamReasoning: reasoningMode === "stream",
   ```

2. **Broadcast thinking events via WebSocket**:
   ```typescript
   emitAgentEvent({
     runId: params.runId,
     stream: "thinking",
     ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
     data: {
       text: rawText,    // Full accumulated thinking content
       delta,            // Incremental content since last event
     },
   });
   ```

3. **Use raw text for accurate delta computation**:
   - `lastStreamedReasoning` stores raw text (not formatted)
   - Frontend handles formatting on display

### 2. Data Layer

**Type Definition**: `src/renderer/types/cowork.ts`

```typescript
export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
  thinkingContent?: string; // Accumulated thinking content during streaming
}
```

### 3. Backend Processing

**File**: `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

#### ActiveTurn State Extension

```typescript
type ActiveTurn = {
  // ...existing fields
  currentThinkingMessageId: string | null;
  currentThinkingContent: string;
  thinkingStreamEnded: boolean;
};
```

#### handleAgentThinkingEvent Method

Handles thinking stream events from OpenClaw:

```typescript
private handleAgentThinkingEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
  const { text, delta } = data as { text: string; delta: string };
  
  // First thinking event: Create assistant message with isThinking metadata
  if (!turn.currentThinkingMessageId) {
    const messageId = uuidv4();
    turn.currentThinkingMessageId = messageId;
    turn.currentThinkingContent = text;
    
    // Create message with isThinking metadata
    this.emit('messageCreate', sessionId, {
      id: messageId,
      type: 'assistant',
      content: '',
      metadata: { isThinking: true },
    });
  } else {
    // Subsequent events: Compute and emit delta
    const actualDelta = text.slice(turn.currentThinkingContent.length);
    turn.currentThinkingContent = text;
    
    this.emit('thinkingUpdate', sessionId, messageId, actualDelta);
  }
}
```

#### dispatchAgentEvent Modification

```typescript
private dispatchAgentEvent(sessionId: string, turn: ActiveTurn, agentPayload: AgentEventPayload): void {
  const stream = agentPayload.stream?.trim() ?? '';
  
  // Handle thinking stream
  if (stream === 'thinking') {
    this.handleAgentThinkingEvent(sessionId, turn, agentPayload.data);
    return;
  }
  
  // When stream changes to non-thinking: finalize thinking message
  if (turn.currentThinkingMessageId && !turn.thinkingStreamEnded) {
    turn.thinkingStreamEnded = true;
    this.emit('messageMetadataUpdate', sessionId, turn.currentThinkingMessageId, {
      isThinking: false,
      thinkingContent: turn.currentThinkingContent,
    });
  }
  
  // Existing logic for tool/tools/lifecycle...
}
```

### 4. IPC Communication Layer

**File**: `src/main/main.ts`

```typescript
runtime.on('thinkingUpdate', (sessionId: string, messageId: string, thinkingDelta: string) => {
  windows.forEach(win => {
    win.webContents.send('cowork:stream:thinkingUpdate', {
      sessionId,
      messageId,
      thinkingDelta,
    });
  });
});
```

**File**: `src/main/preload.ts`

```typescript
onStreamThinkingUpdate: (
  callback: (data: { sessionId: string; messageId: string; thinkingDelta: string }) => void
) => {
  const handler = (_event: any, data: ...) => callback(data);
  ipcRenderer.on('cowork:stream:thinkingUpdate', handler);
  return () => ipcRenderer.removeListener('cowork:stream:thinkingUpdate', handler);
},
```

### 5. Frontend Service Layer

**File**: `src/renderer/services/cowork.ts`

```typescript
private setupStreamListeners(): void {
  // Thinking update listener
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

### 6. Redux Layer

**File**: `src/renderer/store/slices/coworkSlice.ts`

```typescript
// State
interface CoworkState {
  thinkingExpanded: boolean;  // Global toggle state
  // ...
}

// Initial state
thinkingExpanded: true, // Default to expanded

// Action: updateMessageThinkingContent
updateMessageThinkingContent: (state, action) => {
  const session = state.sessions.find(s => s.id === action.payload.sessionId);
  const messageIndex = session?.messages.findIndex(m => m.id === action.payload.messageId);
  if (messageIndex !== undefined && messageIndex >= 0) {
    const newThinking = action.payload.thinkingDelta;
    session.currentSession.messages[messageIndex].thinkingContent =
      (session.currentSession.messages[messageIndex].thinkingContent || '') + newThinking;
  }
},

// Action: toggleThinkingExpanded
toggleThinkingExpanded: (state) => {
  state.thinkingExpanded = !state.thinkingExpanded;
},
```

### 7. UI Layer

**File**: `src/renderer/components/cowork/CoworkSessionDetail.tsx`

#### ThinkingStreamBlock Component

```typescript
const ThinkingStreamBlock: React.FC<{ messageId: string }> = ({ messageId }) => {
  // Subscribe directly to Redux store for real-time updates
  const thinkingState = useSyncExternalStore(
    (callback) => store.subscribe(callback),
    () => {
      const state = store.getState();
      const globalExpanded = state.cowork.thinkingExpanded;
      const msg = state.cowork.currentSession?.messages?.find(m => m.id === messageId);
      return {
        content: msg?.thinkingContent || '',
        isStreaming: msg?.metadata?.isThinking || false,
        globalExpanded,
      };
    }
  );
  
  const { content, isStreaming, globalExpanded } = thinkingState;
  
  // Status text
  const statusText = isStreaming
    ? i18nService.t('thinkingInProgress')  // "正在思考..."
    : i18nService.t('thinkingComplete');    // "思考完成"
  
  return (
    <div className="mb-3">
      {/* Header with toggle */}
      <button onClick={() => setLocalExpanded(!localExpanded)}>
        <BrainIcon />
        <span>{statusText}</span>
        {isStreaming && <TypingIndicator />}
      </button>
      
      {/* Content - uses MarkdownContent for formatting */}
      {effectiveExpanded && (
        <div className="mt-2 pl-4 text-xs text-muted-foreground">
          <MarkdownContent content={content} className="max-w-none" />
        </div>
      )}
    </div>
  );
};
```

#### AssistantMessageItem Integration

```typescript
const AssistantMessageItem: React.FC<{...}> = ({ message, ... }) => {
  const hasThinking = message.thinkingContent && message.thinkingContent.length > 0;
  
  return (
    <div className="relative">
      {/* Thinking block at top */}
      {hasThinking && <ThinkingStreamBlock messageId={message.id} />}
      
      {/* Normal content */}
      {message.content && <MarkdownContent content={message.content} />}
    </div>
  );
};
```

#### Global Toggle Button

```typescript
// In session header
const thinkingExpanded = useSelector(selectThinkingExpanded);

<Button onClick={() => dispatch(toggleThinkingExpanded())}>
  <BrainIcon className={thinkingExpanded ? 'text-blue-500' : 'text-gray-400'} />
  {thinkingExpanded ? i18nService.t('collapseThinking') : i18nService.t('expandThinking')}
</Button>
```

### 8. Database Persistence

**File**: `src/main/sqliteStore.ts`

```typescript
// Migration: Add thinking_content column
if (!msgColNames.includes('thinking_content')) {
  this.db.exec('ALTER TABLE cowork_messages ADD COLUMN thinking_content TEXT');
}
```

**File**: `src/main/coworkStore.ts`

```typescript
// Row type
interface CoworkMessageRow {
  // ...
  thinking_content: string | null;
}

// Read thinking_content from database
private getSessionMessages(sessionId: string): CoworkMessage[] {
  const rows = this.getAll<CoworkMessageRow>(
    `SELECT id, type, content, metadata, created_at, sequence, thinking_content
     FROM cowork_messages WHERE session_id = ? ...`
  );
  return rows.map(row => ({
    // ...
    ...(row.thinking_content ? { thinkingContent: row.thinking_content } : {}),
  }));
}

// Save thinking_content when adding message
INSERT INTO cowork_messages (..., thinking_content) VALUES (..., ?)

// Update thinking_content
updateMessage(sessionId, messageId, updates: { thinkingContent?: string }) {
  if (updates.thinkingContent !== undefined) {
    setClauses.push('thinking_content = ?');
    values.push(updates.thinkingContent || null);
  }
}
```

### 9. i18n Support

**File**: `src/renderer/services/i18n.ts`

```typescript
// Chinese
{
  thinking: '思考中...',
  thinkingInProgress: '正在思考...',
  thinkingComplete: '思考完成',
  collapseThinking: '折叠思考内容',
  expandThinking: '展开思考内容',
}

// English
{
  thinking: 'Thinking...',
  thinkingInProgress: 'Thinking...',
  thinkingComplete: 'Thinking complete',
  collapseThinking: 'Collapse thinking content',
  expandThinking: 'Expand thinking content',
}
```

### 10. Gateway Bundle

**File**: `scripts/bundle-openclaw-gateway.cjs`

The bundler script ensures the patched OpenClaw code is bundled into a single file (`gateway-bundle.mjs`) for faster startup.

## Event Flow Summary

1. **User sends message** → OpenClaw starts generation with `reasoningMode: "stream"`
2. **OpenClaw generates thinking** → `emitAgentEvent({ stream: "thinking", data: { text, delta } })`
3. **RuntimeAdapter receives event** → `handleAgentThinkingEvent()` creates/updates message
4. **Router forwards event** → `emit('thinkingUpdate')` to main process
5. **Main process broadcasts IPC** → `win.webContents.send('cowork:stream:thinkingUpdate')`
6. **Renderer receives IPC** → `dispatch(updateMessageThinkingContent)`
7. **Redux updates state** → `thinkingContent` field updated
8. **UI re-renders** → `ThinkingStreamBlock` shows real-time content
9. **Stream ends** → `messageMetadataUpdate` with `isThinking: false`
10. **Content persisted** → Saved to `thinking_content` column in database

## Key Features

| Feature | Description |
|---------|-------------|
| Real-time streaming | Thinking content displayed as it's generated |
| Collapsible UI | Per-block and global toggle for expand/collapse |
| Status indicator | "正在思考..." during streaming, "思考完成" when done |
| Markdown rendering | Thinking content rendered with MarkdownContent |
| Persistence | Thinking content saved to database for session reload |
| i18n support | Chinese and English translations |

## Related Files

| File | Purpose |
|------|---------|
| `scripts/patches/v2026.4.11/openclaw-thinking-stream.patch` | OpenClaw patch for thinking stream |
| `src/renderer/types/cowork.ts` | `thinkingContent` field definition |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | Thinking event handling |
| `src/main/libs/agentEngine/coworkEngineRouter.ts` | Event forwarding |
| `src/main/main.ts` | IPC broadcast |
| `src/main/preload.ts` | IPC listener setup |
| `src/renderer/services/cowork.ts` | Redux action dispatch |
| `src/renderer/store/slices/coworkSlice.ts` | State management |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | UI components |
| `src/main/coworkStore.ts` | Database persistence |
| `src/main/sqliteStore.ts` | Migration and column definition |
| `scripts/bundle-openclaw-gateway.cjs` | Gateway bundling |