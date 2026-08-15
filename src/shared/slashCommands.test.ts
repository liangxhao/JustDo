import { describe, expect, it } from 'vitest';

import {
  hasSlashCommandBeforeSendHook,
  isGoalClearCommand,
  parseGoalStartObjective,
  parseSlashCommand,
  resolveSlashCommandBehavior,
  shouldClearSlashCommandComposerBeforeExecution,
  SlashCommandBeforeSendHook,
} from './slashCommands';

describe('slash command behavior', () => {
  it('parses command names and arguments consistently', () => {
    expect(parseSlashCommand('  /GOAL start a release  ')).toEqual({
      name: 'goal',
      argumentsText: 'start a release',
    });
    expect(parseSlashCommand('not a command')).toBeNull();
  });

  it('defaults new commands to Gateway delivery', () => {
    expect(resolveSlashCommandBehavior('/future-command value')).toMatchObject({
      name: 'future-command',
      argumentsText: 'value',
      execution: 'gateway',
    });
  });

  it('describes special command behavior centrally', () => {
    expect(shouldClearSlashCommandComposerBeforeExecution('/compact')).toBe(true);
    expect(
      hasSlashCommandBeforeSendHook('/goal ship it', SlashCommandBeforeSendHook.EnsureSessionEntry),
    ).toBe(true);
  });

  it.each(['exec', 'elevated', 'elev', 'config', 'allowlist', 'approve', 'cron', 'node', 'nodes'])(
    'blocks the app-managed /%s command from Gateway delivery',
    name => {
      expect(resolveSlashCommandBehavior(`/${name} full`)).toMatchObject({
        name,
        execution: 'blocked',
      });
    },
  );
});

describe('parseGoalStartObjective', () => {
  it('extracts bare and explicit goal objectives', () => {
    expect(parseGoalStartObjective('/goal build a release dashboard')).toBe(
      'build a release dashboard',
    );
    expect(parseGoalStartObjective('/goal start ship the desktop app')).toBe(
      'ship the desktop app',
    );
    expect(parseGoalStartObjective('/goal --tokens 50K improve startup time')).toBe(
      '--tokens 50K improve startup time',
    );
  });

  it('does not treat lifecycle controls as new goals', () => {
    expect(parseGoalStartObjective('/goal')).toBeNull();
    expect(parseGoalStartObjective('/goal status')).toBeNull();
    expect(parseGoalStartObjective('/goal complete')).toBeNull();
    expect(parseGoalStartObjective('write a goal')).toBeNull();
  });
});

describe('isGoalClearCommand', () => {
  it('matches only the clear lifecycle command', () => {
    expect(isGoalClearCommand('/goal clear')).toBe(true);
    expect(isGoalClearCommand('/GOAL CLEAR')).toBe(true);
    expect(isGoalClearCommand('/goal clear now')).toBe(false);
    expect(isGoalClearCommand('/goal write clear instructions')).toBe(false);
    expect(isGoalClearCommand('/goal complete')).toBe(false);
  });
});
