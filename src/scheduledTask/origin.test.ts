import { test, expect } from 'vitest';
import { makeTask } from './fixtures';
import { inferOriginAndBinding } from './origin';
import { OriginKind, BindingKind, DeliveryMode, DeliveryChannel } from './constants';

test('infer: managed key without IM channel -> cowork origin + ui_session binding', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: 'agent:main:gucciai:sess-001', delivery: { mode: DeliveryMode.None } }),
  );
  expect(result.origin).toEqual({ kind: OriginKind.Cowork, sessionId: 'sess-001' });
  expect(result.binding).toEqual({ kind: BindingKind.UISession, sessionId: 'sess-001' });
});

test('infer: managed key with IM announce channel -> im origin + im_session binding', () => {
  const result = inferOriginAndBinding(
    makeTask({
      sessionKey: 'agent:main:gucciai:sess-002',
      delivery: { mode: DeliveryMode.Announce, channel: 'telegram' },
    }),
  );
  expect(result.origin.kind).toBe(OriginKind.IM);
  expect((result.origin as any).platform).toBe('telegram');
  expect(result.binding.kind).toBe(BindingKind.IMSession);
  expect((result.binding as any).platform).toBe('telegram');
  expect((result.binding as any).sessionId).toBe('sess-002');
});

test('infer: non-main agentId managed key -> cowork origin', () => {
  const result = inferOriginAndBinding(
    makeTask({
      sessionKey: 'agent:secondary:gucciai:sess-003',
      delivery: { mode: DeliveryMode.None },
    }),
  );
  expect(result.origin).toEqual({ kind: OriginKind.Cowork, sessionId: 'sess-003' });
  expect(result.binding).toEqual({ kind: BindingKind.UISession, sessionId: 'sess-003' });
});

test('infer: managed key with channel=last -> cowork origin (last is not an IM platform)', () => {
  const result = inferOriginAndBinding(
    makeTask({
      sessionKey: 'agent:main:gucciai:sess-004',
      delivery: { mode: DeliveryMode.Announce, channel: DeliveryChannel.Last },
    }),
  );
  expect(result.origin.kind).toBe(OriginKind.Cowork);
  expect(result.binding.kind).toBe(BindingKind.UISession);
});

test('infer: cron session key -> cron origin', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: 'cron:a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
  );
  expect(result.origin.kind).toBe(OriginKind.Cron);
  expect((result.origin as any).jobId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  expect(result.binding.kind).toBe(BindingKind.SessionKey);
  expect((result.binding as any).sessionKey).toBe('cron:a1b2c3d4-e5f6-7890-abcd-ef1234567890');
});

test('infer: cron session key with agentId -> cron origin', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: 'agent:main:cron:a1b2c3d4-e5f6-7890-abcd-ef1234567890' }),
  );
  expect(result.origin.kind).toBe(OriginKind.Cron);
  expect((result.origin as any).jobId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  expect(result.binding.kind).toBe(BindingKind.SessionKey);
});

test('infer: unknown sessionKey format -> session_key binding fallback', () => {
  const result = inferOriginAndBinding(makeTask({ sessionKey: 'custom:opaque:key:value' }));
  expect(result.origin.kind).toBe(OriginKind.Cowork);
  expect((result.origin as any).sessionId).toBe('');
  expect(result.binding.kind).toBe(BindingKind.SessionKey);
  expect((result.binding as any).sessionKey).toBe('custom:opaque:key:value');
});

test('infer: null sessionKey -> manual origin + new_session binding', () => {
  const result = inferOriginAndBinding(makeTask({ sessionKey: null }));
  expect(result.origin).toEqual({ kind: OriginKind.Manual });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('infer: undefined sessionKey -> manual origin', () => {
  const result = inferOriginAndBinding(makeTask({ sessionKey: undefined }));
  expect(result.origin).toEqual({ kind: OriginKind.Manual });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('infer: empty string sessionKey -> manual origin', () => {
  const result = inferOriginAndBinding(makeTask({ sessionKey: '' }));
  expect(result.origin).toEqual({ kind: OriginKind.Manual });
  expect(result.binding).toEqual({ kind: BindingKind.NewSession });
});

test('infer: sessionKey with whitespace is trimmed before parsing', () => {
  const result = inferOriginAndBinding(
    makeTask({ sessionKey: '  agent:main:gucciai:sess-trimmed  ' }),
  );
  expect(result.origin.kind).toBe(OriginKind.Cowork);
  expect((result.origin as any).sessionId).toBe('sess-trimmed');
});

test('infer: pure function - same input, same output', () => {
  const task = makeTask({ sessionKey: 'agent:main:gucciai:sess-stable' });
  const r1 = inferOriginAndBinding(task);
  const r2 = inferOriginAndBinding(task);
  expect(r1).toEqual(r2);
});

test('infer: missing delivery field does not crash', () => {
  const result = inferOriginAndBinding({ sessionKey: null } as any);
  expect(result.origin).toEqual({ kind: OriginKind.Manual });
});
