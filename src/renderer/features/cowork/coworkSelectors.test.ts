import { expect, test } from 'vitest';

import type { RootState } from '@/store';

import { selectCurrentSessionMainRuntimeRunning } from './coworkSelectors';
import coworkReducer, { setCurrentSession, setSessionRuntimeSnapshot } from './coworkSlice';
import type { CoworkSession } from './coworkTypes';

const session = (id: string): CoworkSession => ({
  id,
  title: id,
  status: 'running',
  pinned: false,
  agentId: 'main',
  cwd: '',
  executionMode: 'local',
  permissionMode: 'ask',
  activeSkillIds: [],
  createdAt: 1,
  updatedAt: 1,
});

test('main controls stay idle while descendants keep the session running', () => {
  let cowork = coworkReducer(undefined, { type: 'init' });
  cowork = {
    ...cowork,
    currentSession: session('source'),
  };
  cowork = coworkReducer(
    cowork,
    setSessionRuntimeSnapshot({
      sessionId: 'source',
      snapshot: {
        revision: 1,
        known: true,
        mainRunning: false,
        subagentRunning: true,
        running: true,
      },
    }),
  );
  expect(cowork.sessionRuntimeActivity.source).toBe(true);
  expect(cowork.currentSession?.status).toBe('running');
  expect(selectCurrentSessionMainRuntimeRunning({ cowork } as RootState)).toBe(false);
});

test('main controls follow the selected session rather than the previous session streaming flag', () => {
  const cowork: ReturnType<typeof coworkReducer> = {
    ...coworkReducer(undefined, { type: 'init' }),
    isStreaming: true,
    sessionMainRuntimeActivity: { A: true },
    currentSession: session('B'),
  };
  expect(selectCurrentSessionMainRuntimeRunning({ cowork } as RootState)).toBe(false);
  expect(
    selectCurrentSessionMainRuntimeRunning({
      cowork: { ...cowork, currentSession: session('A') },
    } as RootState),
  ).toBe(true);
  expect(
    selectCurrentSessionMainRuntimeRunning({
      cowork: { ...cowork, currentSession: session('temp-A') },
    } as RootState),
  ).toBe(true);
});

test('unconfirmed admission preserves the main stop control until a known idle observation', () => {
  let cowork = coworkReducer(
    undefined,
    setCurrentSession({
      id: 'source',
      title: 'Source',
      status: 'running',
      pinned: false,
      agentId: 'main',
      cwd: '',
      executionMode: 'local',
      permissionMode: 'ask',
      activeSkillIds: [],
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  for (const snapshot of [
    { revision: 1, known: true, mainRunning: true, subagentRunning: false, running: true },
    { revision: 2, known: false, mainRunning: false, subagentRunning: false, running: true },
    { revision: 3, known: false, mainRunning: false, subagentRunning: false, running: false },
  ])
    cowork = coworkReducer(cowork, setSessionRuntimeSnapshot({ sessionId: 'source', snapshot }));
  expect(cowork.isStreaming).toBe(true);
  expect(cowork.sessionRuntimeActivity.source).toBe(true);
  expect(cowork.currentSession?.status).toBe('running');
  expect(selectCurrentSessionMainRuntimeRunning({ cowork } as RootState)).toBe(true);
  cowork = coworkReducer(
    cowork,
    setSessionRuntimeSnapshot({
      sessionId: 'source',
      snapshot: {
        revision: 4,
        known: true,
        mainRunning: false,
        subagentRunning: true,
        running: true,
      },
    }),
  );
  expect(cowork.isStreaming).toBe(false);
  expect(cowork.sessionRuntimeActivity.source).toBe(true);
  expect(selectCurrentSessionMainRuntimeRunning({ cowork } as RootState)).toBe(false);
});
