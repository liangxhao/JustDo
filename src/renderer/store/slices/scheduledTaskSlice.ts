import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { ScheduledTask, ScheduledTaskRun, TaskState } from '@shared/scheduledTask/types';

interface ScheduledTaskState {
  tasks: ScheduledTask[];
  runs: Record<string, ScheduledTaskRun[]>;
  runsHasMore: Record<string, boolean>;
  loading: boolean;
  error: string | null;
}

const initialState: ScheduledTaskState = {
  tasks: [],
  runs: {},
  runsHasMore: {},
  loading: false,
  error: null,
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
} = scheduledTaskSlice.actions;

export default scheduledTaskSlice.reducer;
