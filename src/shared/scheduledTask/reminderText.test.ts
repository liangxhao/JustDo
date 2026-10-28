import { expect, test } from 'vitest';

import {
  isSimpleScheduledReminderText,
  parseScheduledReminderPrompt,
  parseSimpleScheduledReminderText,
} from './reminderText';

const PREFIX = 'A scheduled reminder has been triggered. The reminder content is:';
const INTERNAL =
  'Handle this reminder internally. Do not relay it to the user unless explicitly requested.';
const RELAY = 'Please relay this reminder to the user in a helpful and friendly way.';
const TIME_PREFIX = 'Current time:';

// ---------------------------------------------------------------------------
// parseScheduledReminderPrompt
// ---------------------------------------------------------------------------

test('parseScheduledReminderPrompt: returns null when text does not start with prefix', () => {
  expect(parseScheduledReminderPrompt('Hello world')).toBe(null);
});

test('parseScheduledReminderPrompt: returns null for empty string', () => {
  expect(parseScheduledReminderPrompt('')).toBe(null);
});

test('parseScheduledReminderPrompt: returns null when prefix only, no reminder text', () => {
  expect(parseScheduledReminderPrompt(PREFIX)).toBe(null);
  expect(parseScheduledReminderPrompt(`${PREFIX}   `)).toBe(null);
});

test('parseScheduledReminderPrompt: parses plain reminder text', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Buy groceries`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Buy groceries');
  expect(result!.currentTime).toBe(undefined);
});

test('parseScheduledReminderPrompt: trims input before matching prefix', () => {
  const result = parseScheduledReminderPrompt(`  ${PREFIX} Weekly report due  `);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Weekly report due');
});

test('parseScheduledReminderPrompt: strips trailing internal instruction', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Stand up meeting ${INTERNAL}`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Stand up meeting');
});

test('parseScheduledReminderPrompt: strips trailing relay instruction', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Take a break ${RELAY}`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Take a break');
});

test('parseScheduledReminderPrompt: extracts currentTime from trailing segment', () => {
  const result = parseScheduledReminderPrompt(`${PREFIX} Call dentist ${TIME_PREFIX} 14:30`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('Call dentist');
  expect(result!.currentTime).toBe('14:30');
});

test('parseScheduledReminderPrompt: handles multi-word reminder text', () => {
  const msg = 'Please check the server logs and alert if disk usage is above 90%';
  const result = parseScheduledReminderPrompt(`${PREFIX} ${msg}`);
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe(msg);
});

// ---------------------------------------------------------------------------
// isSimpleScheduledReminderText
// ---------------------------------------------------------------------------

test('isSimpleScheduledReminderText: returns true for text starting with emoji followed by space', () => {
  expect(isSimpleScheduledReminderText('⏰ Check email')).toBe(true);
});

test('isSimpleScheduledReminderText: returns true for bare emoji', () => {
  expect(isSimpleScheduledReminderText('⏰')).toBe(true);
});

test('isSimpleScheduledReminderText: trims leading whitespace before checking', () => {
  expect(isSimpleScheduledReminderText('  ⏰ Alarm')).toBe(true);
});

test('isSimpleScheduledReminderText: returns false for text without emoji at start', () => {
  expect(isSimpleScheduledReminderText('Reminder ⏰')).toBe(false);
});

test('isSimpleScheduledReminderText: returns false for empty string', () => {
  expect(isSimpleScheduledReminderText('')).toBe(false);
});

test('isSimpleScheduledReminderText: returns false for plain text', () => {
  expect(isSimpleScheduledReminderText('Daily standup at 9am')).toBe(false);
});

// ---------------------------------------------------------------------------
// parseSimpleScheduledReminderText
// ---------------------------------------------------------------------------

test('parseSimpleScheduledReminderText: returns prompt for simple emoji text', () => {
  const result = parseSimpleScheduledReminderText('⏰ Check mail');
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('⏰ Check mail');
  expect(result!.currentTime).toBe(undefined);
});

test('parseSimpleScheduledReminderText: returns null for non-simple text', () => {
  expect(parseSimpleScheduledReminderText('No emoji here')).toBe(null);
});

test('parseSimpleScheduledReminderText: preserves the full original trimmed text', () => {
  const result = parseSimpleScheduledReminderText('  ⏰ Buy milk and eggs  ');
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('⏰ Buy milk and eggs');
});

test('parseSimpleScheduledReminderText: bare emoji returns prompt with just the emoji', () => {
  const result = parseSimpleScheduledReminderText('⏰');
  expect(result).not.toBe(null);
  expect(result!.reminderText).toBe('⏰');
});
