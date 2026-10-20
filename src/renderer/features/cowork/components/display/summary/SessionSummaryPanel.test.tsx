// @vitest-environment jsdom
import { type ProgressCard, ProgressCardStepStatus } from '@shared/openclaw/progressCard';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { projectSessionSummaryResources } from '@/libs/openclaw-chat/model/timeline/session-summary-resources';
import { i18nService } from '@/services/i18n';
import { UiStyleScopeBoundary } from '@/shared/dom/styleScope';

import type { Subtask } from '../../subagents/subtaskPresentation';
import SessionSummaryPanel from './SessionSummaryPanel';

afterEach(cleanup);

it('keeps natural-height summary rows in one grid column across layout-free plugin scopes', () => {
  const { props } = fixture();
  render(
    <SessionSummaryPanel
      {...props}
      pluginEntries={
        <>
          <UiStyleScopeBoundary scope="workflow">
            <button>Workflow entry</button>
          </UiStyleScopeBoundary>
          <UiStyleScopeBoundary scope="empty">{null}</UiStyleScopeBoundary>
          <UiStyleScopeBoundary scope="team">
            <button>Team entry</button>
          </UiStyleScopeBoundary>
        </>
      }
    />,
  );
  const workflow = screen.getByRole('button', { name: 'Workflow entry' });
  const team = screen.getByRole('button', { name: 'Team entry' });
  const body = workflow.closest('.session-summary-panel__body')!;
  expect(team.closest('.session-summary-panel__body')).toBe(body);
  for (const utility of [
    'grid',
    'grid-cols-1',
    'auto-rows-max',
    'content-start',
    'gap-4',
    'overflow-y-auto',
  ]) {
    expect(body.classList.contains(utility)).toBe(true);
  }
  expect(body.classList.contains('space-y-4')).toBe(false);
  expect(workflow.closest<HTMLElement>('[data-ui-style-scope]')?.style.display).toBe('contents');
  expect(body.querySelector('[data-ui-style-scope="empty"]')?.childElementCount).toBe(0);
});

it('resizes from the fixed right edge and clamps to the viewport and minimum size', () => {
  const { props, onClose } = fixture();
  render(<SessionSummaryPanel {...props} />);
  const panel = screen.getByRole('dialog');
  const handle = screen.getByRole('button', { name: 'Drag to resize summary, or use arrow keys' });
  const bounds = vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
    width: 320,
    height: 400,
    right: 900,
    top: 64,
  } as DOMRect);
  const viewportHeight = vi
    .spyOn(document.documentElement, 'clientHeight', 'get')
    .mockReturnValue(800);
  try {
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panel.style.width).toBe('336px');
    expect(panel.style.height).toBe('400px');
    bounds.mockReturnValue({ width: 336, height: 400, right: 300, top: 64 } as DOMRect);
    fireEvent(window, new Event('resize'));
    expect(panel.style.maxWidth).toBe('284px');
    expect(panel.style.maxHeight).toBe('720px');
    bounds.mockReturnValue({ width: 890, height: 720, right: 900, top: 64 } as DOMRect);
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(panel.style.width).toBe('884px');
    expect(panel.style.height).toBe('720px');
    bounds.mockReturnValue({ width: 280, height: 160, right: 900, top: 64 } as DOMRect);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(panel.style.width).toBe('280px');
    expect(panel.style.height).toBe('160px');
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    bounds.mockRestore();
    viewportHeight.mockRestore();
  }
});

const progressCard: ProgressCard = {
  sessionKey: 'agent:main:justdo:chat',
  revision: 3,
  updatedAt: Date.now(),
  markdown: 'Current task: Read and take notes\n\nGoal: Finish the book',
  steps: [
    { step: 'Read chapters 1–2', status: ProgressCardStepStatus.Completed },
    { step: 'Read chapters 3–4', status: ProgressCardStepStatus.InProgress },
    { step: 'Write notes', status: ProgressCardStepStatus.Pending },
    { step: 'Share notes', status: ProgressCardStepStatus.Pending },
  ],
};

function fixture() {
  i18nService.setLanguage('en', { persist: false });
  const onOpenSubagents = vi.fn(),
    onOpenWorkflow = vi.fn(),
    onOpenTeam = vi.fn(),
    onOpenResource = vi.fn(),
    onOpenResourceList = vi.fn(),
    onClose = vi.fn();
  const props = {
    sessionId: 'chat',
    visible: true,
    anchorRef: createRef<HTMLButtonElement>(),
    objective: 'Prepare the release',
    tasks: ['running', 'pending', 'done', 'failed', 'timeout', 'unknown'].map((status, index) => ({
      id: String(index),
      status,
    })) as Subtask[],
    resources: {
      sessionKey: 'chat',
      outputs: [],
      sources: Array.from({ length: 5 }, (_, index) => ({
        id: `source-${index}`,
        title: `Source ${index}`,
        target: { kind: 'url' as const, url: `https://example.com/${index}` },
      })),
      outputsLoading: false,
      outputsUnavailable: false,
      omittedOversized: false,
    },
    pluginEntries: (
      <>
        <button onClick={onOpenWorkflow}>Swarm Workflow 2</button>
        <button onClick={onOpenTeam}>Agent Team Collaboration × 1</button>
      </>
    ),
    onOpenSubagents,
    onOpenWorkflow,
    onOpenTeam,
    onOpenResource,
    onOpenResourceList,
    onClose,
  };
  return {
    props,
    onOpenSubagents,
    onOpenWorkflow,
    onOpenTeam,
    onOpenResource,
    onOpenResourceList,
    onClose,
  };
}

it('moves the original task progress into the summary and retains disclosure across revisions', () => {
  const { props, onClose } = fixture();
  const progress = { card: progressCard, runState: 'completed' as const, onRefresh: vi.fn() };
  const { rerender } = render(<SessionSummaryPanel {...props} />);
  expect(screen.queryByRole('heading', { name: 'Task progress' })).toBeNull();

  rerender(<SessionSummaryPanel {...props} progress={progress} />);
  const dialog = screen.getByRole('dialog', { name: 'Summary' });
  const card = within(dialog).getByRole('region', { name: 'Task progress' });
  expect(within(card).getByRole('heading', { name: 'Task progress', level: 3 })).toBeTruthy();
  expect(within(card).getByText('Task progress')).toBeTruthy();
  expect(within(card).getByText('1/4 completed')).toBeTruthy();
  expect(within(card).getByText('Current task: Read and take notes')).toBeTruthy();
  expect(within(card).getByText('Goal: Finish the book')).toBeTruthy();
  expect(within(card).getByRole('img', { name: 'Waiting to continue' }).textContent).toBe('Ⅱ');
  expect(within(card).getAllByRole('listitem')).toHaveLength(4);

  fireEvent.click(within(card).getByRole('button', { expanded: true }));
  expect(within(card).queryByText('Read chapters 1–2')).toBeNull();
  rerender(
    <SessionSummaryPanel
      {...props}
      progress={{ ...progress, card: { ...progressCard, revision: 4 } }}
    />,
  );
  expect(within(card).getByRole('button', { expanded: false })).toBeTruthy();
  fireEvent.click(within(card).getByRole('button', { expanded: false }));
  expect(within(card).getAllByRole('listitem')).toHaveLength(4);

  expect(within(card).queryByRole('button', { name: 'Hide task progress' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(progressCard.steps?.[1]?.status).toBe(ProgressCardStepStatus.InProgress);
  rerender(<SessionSummaryPanel {...props} />);
  expect(screen.queryByRole('region', { name: 'Task progress' })).toBeNull();
});

it('refreshes through the existing progress callback and shows completed progress when reopened', async () => {
  const { props } = fixture();
  const onRefresh = vi.fn().mockResolvedValue(true);
  const progress = { card: progressCard, runState: 'running' as const, onRefresh };
  const { rerender } = render(<SessionSummaryPanel {...props} progress={progress} />);
  const refresh = screen.getByRole('button', {
    name: 'Refresh task progress',
  }) as HTMLButtonElement;
  fireEvent.click(refresh);
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(refresh.disabled).toBe(true);
  expect(screen.getByText('1/4 completed')).toBeTruthy();
  await waitFor(() => expect(refresh.disabled).toBe(false));

  const completedCard = {
    ...progressCard,
    revision: 4,
    steps: progressCard.steps?.map(step => ({
      ...step,
      status: ProgressCardStepStatus.Completed,
    })),
  };
  rerender(
    <SessionSummaryPanel
      {...props}
      progress={{ ...progress, card: completedCard, runState: 'completed' }}
    />,
  );
  expect(refresh.disabled).toBe(false);
  expect(screen.getByText('4/4 completed')).toBeTruthy();
  rerender(
    <SessionSummaryPanel
      {...props}
      visible={false}
      progress={{ ...progress, card: completedCard }}
    />,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  rerender(<SessionSummaryPanel {...props} progress={{ ...progress, card: completedCard }} />);
  expect(screen.getByText('4/4 completed')).toBeTruthy();
  expect(screen.getAllByRole('img', { name: 'Completed' })).toHaveLength(4);
  expect(screen.getByRole('heading', { name: 'Outputs' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Source 0' })).toBeTruthy();
});

it('shows a static objective, three subagent counts, and count-only workflow/team entrances', () => {
  const { props, onOpenSubagents, onOpenWorkflow, onOpenTeam } = fixture();
  render(<SessionSummaryPanel {...props} />);
  expect(screen.getByText('Prepare the release').closest('button')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '2 running 1 completed 2 failed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Swarm Workflow 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Agent Team Collaboration × 1' }));
  expect(onOpenSubagents).toHaveBeenCalledTimes(1);
  expect(onOpenWorkflow).toHaveBeenCalledTimes(1);
  expect(onOpenTeam).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Plan')).toBeNull();
});

it('keeps an empty output section until real outputs arrive, then opens the original resource', () => {
  const { props, onOpenResource } = fixture();
  const emptyProps = {
    ...props,
    objective: undefined,
    tasks: [],
    pluginEntries: null,
  };
  const { rerender } = render(<SessionSummaryPanel {...emptyProps} resources={null} />);
  expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toEqual([
    'Summary',
    'Outputs',
  ]);
  expect(screen.getByText('None').parentElement).toBe(
    screen.getByRole('heading', { name: 'Outputs' }).parentElement,
  );
  expect(screen.getByText('None').closest('button')).toBeNull();
  expect(within(screen.getByRole('dialog')).getAllByRole('button')).toHaveLength(2);

  const resources = { ...props.resources, sources: [], outputsLoading: true };
  rerender(<SessionSummaryPanel {...emptyProps} resources={resources} />);
  expect(screen.getByText('None')).toBeTruthy();

  const output = {
    id: 'report',
    title: 'report.md',
    target: { kind: 'file' as const, path: 'E:/project/report.md' },
  };
  rerender(
    <SessionSummaryPanel
      {...emptyProps}
      resources={{ ...resources, outputs: [output], outputsLoading: false }}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Outputs' })).toBeTruthy();
  expect(screen.queryByText('None')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'report.md' }));
  expect(onOpenResource).toHaveBeenCalledWith(output);

  rerender(
    <SessionSummaryPanel
      {...emptyProps}
      resources={{ ...resources, outputsLoading: false, outputsUnavailable: true }}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Outputs' })).toBeTruthy();
  expect(screen.queryByText('None')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe(
    'Outputs are temporarily unavailable. Please retry later.',
  );
});

it('keeps completed-only summaries compact and hides the section when no subagents exist', () => {
  const { props, onOpenSubagents } = fixture();
  const tasks = props.tasks.slice(0, 2).map(task => ({ ...task, status: 'done' as const }));
  const { rerender } = render(<SessionSummaryPanel {...props} tasks={tasks} />);
  const summary = screen.getByRole('button', { name: '0 running 2 completed 0 failed' });
  expect(within(summary).getByText('2 completed')).toBeTruthy();
  expect(within(summary).queryByText('0 running')).toBeNull();
  expect(within(summary).queryByText('0 failed')).toBeNull();
  fireEvent.click(summary);
  expect(onOpenSubagents).toHaveBeenCalledTimes(1);

  rerender(<SessionSummaryPanel {...props} tasks={[]} />);
  expect(screen.queryByRole('heading', { name: 'Subagents' })).toBeNull();
  expect(screen.queryByRole('button', { name: '0 running 0 completed 0 failed' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Swarm Workflow 2' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Source 0' })).toBeTruthy();

  rerender(<SessionSummaryPanel {...props} tasks={tasks} />);
  expect(screen.getByRole('heading', { name: 'Subagents' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '0 running 2 completed 0 failed' })).toBeTruthy();
});

it.each(['outputs', 'sources'] as const)(
  'opens the complete %s list instead of expanding the summary after three rows',
  kind => {
    const { props, onOpenResource, onOpenResourceList } = fixture();
    const items = props.resources.sources;
    const resources = { ...props.resources, outputs: [], sources: [], [kind]: items.slice(0, 3) };
    const { rerender } = render(<SessionSummaryPanel {...props} resources={resources} />);
    expect(screen.queryByRole('button', { name: 'View all' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Source /u })).toHaveLength(3);

    rerender(<SessionSummaryPanel {...props} resources={{ ...resources, [kind]: items }} />);
    const section = screen
      .getByRole('heading', {
        name: kind === 'outputs' ? 'Outputs' : 'Sources',
      })
      .closest('section')!;
    expect(
      within(section)
        .getAllByRole('button')
        .map(button => button.textContent),
    ).toEqual(['Source 0', 'Source 1', 'Source 2', 'View all']);
    fireEvent.click(within(section).getByRole('button', { name: 'View all' }));
    expect(onOpenResourceList).toHaveBeenCalledWith(kind);
    expect(onOpenResource).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Source 3' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Source 4' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Source 0' }));
    expect(onOpenResource).toHaveBeenCalledWith(items[0]);
  },
);

it('keeps output and source list entrances separate when both exceed three entries', () => {
  const { props, onOpenResourceList } = fixture();
  render(
    <SessionSummaryPanel
      {...props}
      resources={{ ...props.resources, outputs: props.resources.sources }}
    />,
  );
  for (const [name, kind] of [
    ['Outputs', 'outputs'],
    ['Sources', 'sources'],
  ]) {
    const section = screen.getByRole('heading', { name }).closest('section')!;
    fireEvent.click(within(section).getByRole('button', { name: 'View all' }));
    expect(onOpenResourceList).toHaveBeenLastCalledWith(kind);
  }
  expect(onOpenResourceList).toHaveBeenCalledTimes(2);
});

it('shows sources only when native history contains confirmed source entries', () => {
  const { props, onOpenResource } = fixture();
  const { rerender } = render(
    <SessionSummaryPanel {...props} resources={{ ...props.resources, sources: [] }} />,
  );
  expect(screen.queryByRole('heading', { name: 'Sources' })).toBeNull();

  const projection = projectSessionSummaryResources(
    [
      {
        role: 'user',
        __openclaw: { media: [{ path: 'E:/project/input.pdf', fileName: 'input.pdf' }] },
        content: 'Use this file',
      },
      { role: 'assistant', content: '[Example link](https://example.com/guide)' },
    ],
    [],
  );
  rerender(<SessionSummaryPanel {...props} resources={{ ...props.resources, ...projection }} />);
  expect(screen.getByRole('heading', { name: 'Sources' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Example link' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'input.pdf' }));
  expect(onOpenResource).toHaveBeenCalledWith(projection.sources[0]);
  expect(projection.sources[0].target).toEqual({ kind: 'file', path: 'E:/project/input.pdf' });
});

it('dismisses on outside click and Escape, while leaving focus untouched on automatic presentation', () => {
  const { props, onClose } = fixture();
  render(
    <>
      <button ref={props.anchorRef}>Summary trigger</button>
      <input aria-label="Composer" />
      <SessionSummaryPanel {...props} />
    </>,
  );
  const composer = screen.getByRole('textbox');
  composer.focus();
  expect(document.activeElement).toBe(composer);
  fireEvent.pointerDown(composer);
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(document.activeElement).toBe(props.anchorRef.current);
});
