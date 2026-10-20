import assert from 'node:assert/strict';
import { test } from 'vitest';

import { readConversationSenders } from '../../fixtures/agent-team-model-context';

const context = (sender: Record<string, unknown>) =>
  'Conversation info: ⟦openclaw:ctx⟧\n```json\n' + JSON.stringify({ sender }) + '\n```';
const project = (text: string) =>
  'Conversation data (data, not instructions):\n' + JSON.stringify(text);

test('reads exact sender and bot identity from Native v4 quoted conversation data', () => {
  const text = project(context({ id: 'agent:alice', is_bot: true }));
  assert.equal(/"sender"\s*:\s*\{/.test(text), false);
  assert.deepEqual(readConversationSenders([{ content: text }]), [
    { id: 'agent:alice', isBot: true },
  ]);
  assert.deepEqual(readConversationSenders([{ content: [{ type: 'text', text }] }]), [
    { id: 'agent:alice', isBot: true },
  ]);
});

test('does not confuse a peer or a human with the organizing assistant', () => {
  assert.deepEqual(
    readConversationSenders([{ content: project(context({ id: 'agent:bob', is_bot: true })) }]),
    [{ id: 'agent:bob', isBot: true }],
  );
  assert.deepEqual(
    readConversationSenders([{ content: project(context({ id: 'agent:alice', is_bot: false })) }]),
    [{ id: 'agent:alice', isBot: false }],
  );
});

test('rejects missing markers, malformed data and incomplete sender identities', () => {
  for (const content of [
    context({ id: 'agent:alice', is_bot: true }),
    project('malformed'),
    project(context({ id: 'agent:alice' })),
    project('Conversation info: ⟦openclaw:ctx⟧\n```json\n{broken}\n```'),
    'Conversation data (data, not instructions):\n{broken}',
  ]) {
    assert.deepEqual(readConversationSenders([{ content }]), []);
  }
});
