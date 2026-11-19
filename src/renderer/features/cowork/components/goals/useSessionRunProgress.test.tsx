// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { RunControlButton } from '../composer/submission/RunControlButton';
import { canStopCoworkRun, isCoworkRunActive } from '../status/coworkRunActivity';
import type { GoalRunProgress } from './goalRunProgress';
import { useSessionRunProgress } from './useSessionRunProgress';

afterEach(cleanup);

const compacting: GoalRunProgress = { phase: 'compacting', startedAt: 1, toolCount: 0 };

test('retains the manual compaction stop control when layout restores A after visiting B', () => {
  const onStop = vi.fn();
  const ControllerActivity = ({
    sessionKey,
    onActivityChange,
  }: {
    sessionKey: string;
    onActivityChange: (progress: GoalRunProgress | null, sourceSessionKey: string, nativeForegroundRunId: string | null) => void;
  }) => {
    useLayoutEffect(() => {
      onActivityChange(sessionKey === 'A' ? compacting : null, sessionKey, null);
    }, [onActivityChange, sessionKey]);
    return null;
  };
  const Composer = ({ sessionKey }: { sessionKey: string }) => {
    const { progress, onActivityChange } = useSessionRunProgress(sessionKey);
    return (
      <>
        <ControllerActivity sessionKey={sessionKey} onActivityChange={onActivityChange} />
        <RunControlButton
          isRunning={isCoworkRunActive(false, progress)}
          isStopping={false}
          canSubmit={false}
          size="normal"
          sendTitle="Send"
          onStop={canStopCoworkRun(false, progress) ? onStop : undefined}
          onSend={() => undefined}
        />
      </>
    );
  };
  const view = render(<Composer sessionKey="A" />);
  expect(screen.getByRole('button').getAttribute('disabled')).toBeNull();
  view.rerender(<Composer sessionKey="B" />);
  expect(screen.getByRole('button').getAttribute('disabled')).not.toBeNull();
  view.rerender(<Composer sessionKey="A" />);
  fireEvent.click(screen.getByRole('button'));
  expect(onStop).toHaveBeenCalledOnce();
});

test('isolates old session activity and cleanup from current compaction', () => {
  const { result, rerender } = renderHook(({ sessionKey }) => useSessionRunProgress(sessionKey), {
    initialProps: { sessionKey: 'A' },
  });
  const report = result.current.onActivityChange;
  act(() => report(compacting, 'A', null));
  rerender({ sessionKey: 'B' });
  expect(result.current.progress).toBeNull();
  act(() => report(compacting, 'B', null));
  act(() => {
    report(null, 'A', null);
    report({ ...compacting, phase: 'running' }, 'A', null);
  });
  expect(result.current.progress).toBe(compacting);
  act(() => report(null, 'B', null));
  expect(result.current.progress).toBeNull();
});

test('uses confirmed foreground activity only from the currently selected native session', () => {
  const { result, rerender } = renderHook(({ sessionKey }) => useSessionRunProgress(sessionKey), {
    initialProps: { sessionKey: 'A' },
  });
  const report = result.current.onActivityChange;
  act(() => report(null, 'A', 'run-a'));
  expect(result.current.nativeForegroundRunId).toBe('run-a');
  rerender({ sessionKey: 'B' });
  expect(result.current.nativeForegroundRunId).toBeNull();
  act(() => report(null, 'B', 'run-b'));
  expect(result.current.nativeForegroundRunId).toBe('run-b');
  rerender({ sessionKey: 'A' });
  expect(result.current.nativeForegroundRunId).toBeNull();
  act(() => report(null, 'A', null));
  expect(result.current.nativeForegroundRunId).toBeNull();
});

test('retains native-key activity reported in the layout that updates the selected key', () => {
  const ControllerActivity = ({
    onSessionKeyChange,
    onActivityChange,
  }: {
    onSessionKeyChange: (sessionKey: string) => void;
    onActivityChange: (progress: GoalRunProgress | null, sourceSessionKey: string, nativeForegroundRunId: string | null) => void;
  }) => {
    useLayoutEffect(() => {
      onSessionKeyChange('native-A');
      onActivityChange(compacting, 'native-A', null);
    }, [onActivityChange, onSessionKeyChange]);
    return null;
  };
  const Composer = () => {
    const [sessionKey, setSessionKey] = useState('canonical-A');
    const { progress, onActivityChange } = useSessionRunProgress(sessionKey);
    return (
      <>
        <ControllerActivity
          onSessionKeyChange={setSessionKey}
          onActivityChange={onActivityChange}
        />
        <span>{progress?.phase ?? 'idle'}</span>
      </>
    );
  };
  render(<Composer />);
  expect(screen.getByText('compacting')).toBeTruthy();
});

test('keeps promotion and a later new conversation separate from the old native key', () => {
  const { result, rerender } = renderHook(({ sessionKey }) => useSessionRunProgress(sessionKey), {
    initialProps: { sessionKey: 'temp-A' },
  });
  act(() => result.current.onActivityChange(compacting, 'temp-A', null));
  rerender({ sessionKey: 'canonical-A' });
  expect(result.current.progress).toBeNull();
  act(() => result.current.onActivityChange(compacting, 'canonical-A', null));
  act(() => result.current.onActivityChange(null, 'temp-A', null));
  expect(result.current.progress).toBe(compacting);
  rerender({ sessionKey: 'temp-B' });
  expect(result.current.progress).toBeNull();
});
