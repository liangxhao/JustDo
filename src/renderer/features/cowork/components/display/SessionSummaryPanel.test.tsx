// @vitest-environment jsdom
import { type ProgressCard, ProgressCardStepStatus } from '@shared/openclaw/progressCard';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { projectSessionSummaryResources } from '@/libs/openclaw-chat/model/session-summary-resources';
import { i18nService } from '@/services/i18n';

import type { Subtask } from '../subagents/subtaskPresentation';
import { type AgentTeamEntry, AgentTeamKind, buildAgentTeamEntries } from './agentTeamEntries';
import SessionSummaryPanel from './SessionSummaryPanel';

afterEach(cleanup);

function mixedTeamEntries() {
  return buildAgentTeamEntries(
    'chat',
    [
      {
        id: 'room',
        anchorSessionId: 'chat',
        members: [],
        rounds: [
          { id: 'old', state: 'settled', pending: 0 },
          { id: 'new', state: 'open', pending: 1 },
        ],
      },
    ],
    ['chat', 'chat', 'chat', 'other'].map((sourceSessionId, index) => ({
      id: 'group-' + index,
      title: 'Topic ' + index,
      sourceSessionId,
      state: 'ready',
      members: [],
    })),
    key => i18nService.t(key),
  );
}

it('shows per-mode counts and opens team tabs directly without a second summary menu', () => {
  const { props, onOpenTeam } = fixture();
  i18nService.setLanguage('zh', { persist: false });
  render(<SessionSummaryPanel {...props} teamEntries={mixedTeamEntries()} />);
  const button = screen.getByRole('button', { name: 'Agent Team 协作 × 2，群聊 × 3' });
  expect(button.hasAttribute('aria-haspopup')).toBe(false);
  fireEvent.click(button);
  expect(onOpenTeam).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.queryByText('Topic 0')).toBeNull();
  expect(screen.queryByRole('button', { name: '全部团队记录' })).toBeNull();
});

it('hides retained team records in the summary while the plugin is disabled', () => {
  const { props, onOpenTeam } = fixture();
  const { rerender } = render(<SessionSummaryPanel {...props} />);
  expect(screen.getByRole('button', { name: /Agent Team/ })).toBeTruthy();
  rerender(<SessionSummaryPanel {...props} teamEnabled={false} />);
  expect(screen.queryByRole('button', { name: /Agent Team/ })).toBeNull();
  expect(screen.getByRole('button', { name: '2 running 1 completed 2 failed' })).toBeTruthy();
  expect(onOpenTeam).not.toHaveBeenCalled();
  rerender(<SessionSummaryPanel {...props} />);
  expect(screen.getByRole('button', { name: /Agent Team/ })).toBeTruthy();
});

it.each([
  ['zh', AgentTeamKind.TASK, 'Agent Team 协作 × 2'],
  ['zh', AgentTeamKind.GROUP, 'Agent Team 群聊 × 3'],
  ['en', AgentTeamKind.TASK, 'Agent Team Collaboration × 2'],
  ['en', AgentTeamKind.GROUP, 'Agent Team Groups × 3'],
] as const)('omits the empty mode for %s %s teams', (language, kind, label) => {
  const { props, onOpenTeam } = fixture();
  i18nService.setLanguage(language, { persist: false });
  render(
    <SessionSummaryPanel
      {...props}
      teamEntries={mixedTeamEntries().filter(entry => entry.kind === kind)}
    />,
  );
  const button = screen.getByRole('button', { name: label });
  expect(button.textContent).not.toContain('× 0');
  expect(button.textContent).not.toContain('，');
  expect(button.textContent).not.toContain(',');
  fireEvent.click(button);
  expect(onOpenTeam).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).toBeNull();
});

it('hides team navigation when switching to a conversation without teams even if global history exists', () => {
  const { props, onOpenTeam } = fixture();
  const { rerender } = render(<SessionSummaryPanel {...props} />);
  expect(screen.getByRole('button', { name: 'Agent Team Collaboration × 1' })).toBeTruthy();
  rerender(<SessionSummaryPanel {...props} sessionId="unrelated" teamEntries={[]} />);
  expect(screen.queryByRole('button', { name: /Agent Team/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'All team records' })).toBeNull();
  expect(onOpenTeam).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
  rerender(<SessionSummaryPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Agent Team Collaboration × 1' }));
  expect(onOpenTeam).toHaveBeenCalledTimes(1);
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
    workflowCount: 2,
    teamEnabled: true,
    teamEntries: [
      {
        kind: AgentTeamKind.TASK,
        key: 'task:room:old',
        roomId: 'room',
        roundId: 'old',
        label: 'Task 1',
        memberCount: 3,
        statusKey: 'teamRecordEnded',
      },
    ] as AgentTeamEntry[],
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
  const refresh = screen.getByRole('button', { name: 'Update task progress' }) as HTMLButtonElement;
  fireEvent.click(refresh);
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(refresh.disabled).toBe(true);
  expect(screen.getByText('1/4 completed')).toBeTruthy();
  await Promise.resolve();

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
    workflowCount: 0,
    teamEntries: [],
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
  expect(within(screen.getByRole('dialog')).getAllByRole('button')).toHaveLength(1);

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
