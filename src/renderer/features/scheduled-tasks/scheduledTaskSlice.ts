import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  ScheduledTask,
  ScheduledTaskResult,
  ScheduledTaskRun,
  TaskState,
} from '@shared/scheduledTask/types';

interface ScheduledTaskState {
  tasks: ScheduledTask[];
  runs: Record<string, ScheduledTaskRun[]>;
  runsHasMore: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  results: ScheduledTaskResult[];
  resultsNextCursor: string | null;
  resultsLoading: boolean;
  resultsInitialized: boolean;
  unreadResultCount: number;
  resultFilter: { taskId: string | null; unreadOnly: boolean };
}

const initialState: ScheduledTaskState = {
  tasks: [],
  runs: {},
  runsHasMore: {},
  loading: false,
  error: null,
  results: [],
  resultsNextCursor: null,
  resultsLoading: false,
  resultsInitialized: false,
  unreadResultCount: 0,
  resultFilter: { taskId: null, unreadOnly: false },
};

const scheduledTaskSlice = createSlice({
  name: 'scheduledTask',
  initialState,
  reducers: {
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setTasks(state, action: PayloadAction<ScheduledTask[]>) {
      state.tasks = action.payload;
      state.loading = false;
    },
    addTask(state, action: PayloadAction<ScheduledTask>) {
      state.tasks.unshift(action.payload);
    },
    updateTask(state, action: PayloadAction<ScheduledTask>) {
      const index = state.tasks.findIndex(t => t.id === action.payload.id);
      if (index !== -1) {
        state.tasks[index] = action.payload;
      }
    },
    removeTask(state, action: PayloadAction<string>) {
      state.tasks = state.tasks.filter(t => t.id !== action.payload);
      delete state.runs[action.payload];
      delete state.runsHasMore[action.payload];
    },
    updateTaskState(state, action: PayloadAction<{ taskId: string; taskState: TaskState }>) {
      const task = state.tasks.find(t => t.id === action.payload.taskId);
      if (task) {
        task.state = action.payload.taskState;
      }
    },
    setRuns(
      state,
      action: PayloadAction<{ taskId: string; runs: ScheduledTaskRun[]; hasMore: boolean }>,
    ) {
      state.runs[action.payload.taskId] = action.payload.runs;
      state.runsHasMore[action.payload.taskId] = action.payload.hasMore;
    },
    appendRuns(
      state,
      action: PayloadAction<{ taskId: string; runs: ScheduledTaskRun[]; hasMore: boolean }>,
    ) {
      const { taskId, runs, hasMore } = action.payload;
      if (!state.runs[taskId]) {
        state.runs[taskId] = runs;
      } else {
        const existingIds = new Set(state.runs[taskId].map(r => r.id));
        const newRuns = runs.filter(r => !existingIds.has(r.id));
        state.runs[taskId] = [...state.runs[taskId], ...newRuns];
      }
      state.runsHasMore[taskId] = hasMore;
    },
    addOrUpdateRun(state, action: PayloadAction<ScheduledTaskRun>) {
      const { taskId } = action.payload;
      if (!state.runs[taskId]) {
        state.runs[taskId] = [];
      }
      const existingIndex = state.runs[taskId].findIndex(r => r.id === action.payload.id);
      if (existingIndex !== -1) {
        state.runs[taskId][existingIndex] = action.payload;
      } else {
        state.runs[taskId].unshift(action.payload);
      }
    },
    setResultsLoading(state, action: PayloadAction<boolean>) {
      state.resultsLoading = action.payload;
    },
    replaceResults(
      state,
      action: PayloadAction<{ results: ScheduledTaskResult[]; nextCursor: string | null }>,
    ) {
      state.results = [...action.payload.results].sort(
        (a, b) =>
          Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id),
      );
      state.resultsNextCursor = action.payload.nextCursor;
      state.resultsInitialized = true;
      state.resultsLoading = false;
    },
    appendResults(
      state,
      action: PayloadAction<{ results: ScheduledTaskResult[]; nextCursor: string | null }>,
    ) {
      const byId = new Map(state.results.map(result => [result.id, result]));
      action.payload.results.forEach(result => byId.set(result.id, result));
      state.results = [...byId.values()].sort(
        (a, b) =>
          Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id),
      );
      state.resultsNextCursor = action.payload.nextCursor;
      state.resultsLoading = false;
    },
    upsertResult(state, action: PayloadAction<ScheduledTaskResult>) {
      const matchesFilter =
        (!state.resultFilter.taskId || state.resultFilter.taskId === action.payload.taskId) &&
        (!state.resultFilter.unreadOnly || action.payload.readAt === null);
      const index = state.results.findIndex(result => result.id === action.payload.id);
      if (!matchesFilter) {
        if (index >= 0) state.results.splice(index, 1);
        return;
      }
      if (index >= 0) state.results[index] = action.payload;
      else state.results.push(action.payload);
      state.results.sort(
        (a, b) =>
          Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id),
      );
    },
    setUnreadResultCount(state, action: PayloadAction<number>) {
      state.unreadResultCount = Math.max(0, action.payload);
    },
    markResultReadLocal(state, action: PayloadAction<string>) {
      const index = state.results.findIndex(item => item.id === action.payload);
      if (index < 0) return;
      if (state.resultFilter.unreadOnly) {
        state.results.splice(index, 1);
      } else if (state.results[index].readAt === null) {
        state.results[index].readAt = new Date().toISOString();
      }
    },
    markAllResultsReadLocal(state, action: PayloadAction<string | undefined>) {
      const now = new Date().toISOString();
      if (state.resultFilter.unreadOnly) {
        state.results = state.results.filter(
          result => action.payload !== undefined && result.taskId !== action.payload,
        );
        return;
      }
      state.results.forEach(result => {
        if (
          result.readAt === null &&
          (action.payload === undefined || result.taskId === action.payload)
        ) {
          result.readAt = now;
        }
      });
    },
    removeResultLocal(state, action: PayloadAction<string>) {
      state.results = state.results.filter(result => result.id !== action.payload);
    },
    setResultFilter(
      state,
      action: PayloadAction<{ taskId: string | null; unreadOnly: boolean }>,
    ) {
      state.resultFilter = action.payload;
      state.results = [];
      state.resultsNextCursor = null;
      state.resultsInitialized = false;
    },
  },
});

export const {
  setLoading,
  setError,
  setTasks,
  addTask,
  updateTask,
  removeTask,
  updateTaskState,
  setRuns,
  appendRuns,
  addOrUpdateRun,
  setResultsLoading,
  replaceResults,
  appendResults,
  upsertResult,
  setUnreadResultCount,
  markResultReadLocal,
  markAllResultsReadLocal,
  removeResultLocal,
  setResultFilter,
} = scheduledTaskSlice.actions;

export default scheduledTaskSlice.reducer;
