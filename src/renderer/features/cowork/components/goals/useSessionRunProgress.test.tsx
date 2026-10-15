// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { RunControlButton } from '../composer/RunControlButton';
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
    onActivityChange: (progress: GoalRunProgress | null, sourceSessionKey: string) => void;
  }) => {
    useLayoutEffect(() => {
      onActivityChange(sessionKey === 'A' ? compacting : null, sessionKey);
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
  act(() => report(compacting, 'A'));
  rerender({ sessionKey: 'B' });
  expect(result.current.progress).toBeNull();
  act(() => report(compacting, 'B'));
  act(() => {
    report(null, 'A');
    report({ ...compacting, phase: 'running' }, 'A');
  });
  expect(result.current.progress).toBe(compacting);
  act(() => report(null, 'B'));
  expect(result.current.progress).toBeNull();
});

test('retains native-key activity reported in the layout that updates the selected key', () => {
  const ControllerActivity = ({
    onSessionKeyChange,
    onActivityChange,
  }: {
    onSessionKeyChange: (sessionKey: string) => void;
    onActivityChange: (progress: GoalRunProgress | null, sourceSessionKey: string) => void;
  }) => {
    useLayoutEffect(() => {
      onSessionKeyChange('native-A');
      onActivityChange(compacting, 'native-A');
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
  act(() => result.current.onActivityChange(compacting, 'temp-A'));
  rerender({ sessionKey: 'canonical-A' });
  expect(result.current.progress).toBeNull();
  act(() => result.current.onActivityChange(compacting, 'canonical-A'));
  act(() => result.current.onActivityChange(null, 'temp-A'));
  expect(result.current.progress).toBe(compacting);
  rerender({ sessionKey: 'temp-B' });
  expect(result.current.progress).toBeNull();
});
