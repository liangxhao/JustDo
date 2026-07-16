import { describe, expect, it } from 'vitest';

import { GatewayStdoutLogFilter } from './gatewayLogFilter';

describe('GatewayStdoutLogFilter', () => {
  it('keeps only the first and last thinking event for a run', () => {
    const filter = new GatewayStdoutLogFilter();
    const first = '[ws] → event agent run=run-1 stream=thinking aseq=2\n';
    const middle = '[ws] → event agent run=run-1 stream=thinking aseq=3\n';
    const last = '[ws] → event agent run=run-1 stream=thinking aseq=28\n';
    const lifecycle = '[ws] → event agent run=run-1 stream=lifecycle phase=end\n';

    expect(filter.push(first)).toBe(first);
    expect(filter.push(middle + last)).toBe('');
    expect(filter.push(lifecycle)).toBe(last + lifecycle);
  });

  it('does not let unrelated logs split a buffered stream', () => {
    const filter = new GatewayStdoutLogFilter();
    const first = '[ws] → event agent run=run-1 stream=thinking aseq=2\n';
    const last = '[ws] → event agent run=run-1 stream=thinking aseq=28\n';
    const diagnostic = '[diagnostic] heartbeat: active=1\n';

    expect(filter.push(first + last + diagnostic)).toBe(first + diagnostic);
    expect(filter.flush()).toBe(last);
  });

  it('does not duplicate a single stream event when the run ends', () => {
    const filter = new GatewayStdoutLogFilter();
    const only = '[ws] → event agent run=run-1 stream=thinking aseq=2\n';
    const lifecycle = '[ws] → event agent run=run-1 stream=lifecycle phase=end\n';

    expect(filter.push(only + lifecycle)).toBe(only + lifecycle);
    expect(filter.flush()).toBe('');
  });

  it('handles log lines split across stdout chunks', () => {
    const filter = new GatewayStdoutLogFilter();
    const line = '[ws] → event agent run=run-1 stream=thinking aseq=2\n';

    expect(filter.push(line.slice(0, 25))).toBe('');
    expect(filter.push(line.slice(25))).toBe(line);
  });

  it('filters timestamped transport events containing ANSI color sequences', () => {
    const filter = new GatewayStdoutLogFilter();
    const timestamp = '2026-07-16T17:21:42.895+08:00 ';
    const first =
      `${timestamp}\u001b[35m[ws]\u001b[0m → event agent seq=per-client clients=3 ` +
      'run=run-1 agent=main session=justdo:session-1 stream=assistant aseq=344 text=All\n';
    const middle =
      `${timestamp}\u001b[35m[ws]\u001b[0m → event agent seq=per-client clients=3 ` +
      'run=run-1 agent=main session=justdo:session-1 stream=assistant aseq=352 text=All tools\n';
    const chat =
      `${timestamp}\u001b[35m[ws]\u001b[0m → event chat seq=per-client clients=3 ` +
      'dropIfSlow=true\n';
    const lifecycle =
      `${timestamp}[ws] → event agent run=run-1 stream=lifecycle phase=end\n`;

    expect(filter.push(first + middle + chat)).toBe(
      `${timestamp}[ws] → event agent seq=per-client clients=3 ` +
        'run=run-1 agent=main session=justdo:session-1 stream=assistant aseq=344 ' +
        'textChars=3 preview="All"\n',
    );
    expect(filter.push(lifecycle)).toBe(
      `${timestamp}[ws] → event agent seq=per-client clients=3 ` +
        'run=run-1 agent=main session=justdo:session-1 stream=assistant aseq=352 ' +
        'textChars=9 preview="All tools"\n' +
        lifecycle,
    );
  });

  it('keeps a bounded assistant text preview', () => {
    const filter = new GatewayStdoutLogFilter();
    const first = '[ws] → event agent run=run-1 stream=assistant aseq=71 text=好\n';
    const middle = '[ws] → event agent run=run-1 stream=assistant aseq=72 text=好的\n';
    const last = '[ws] → event agent run=run-1 stream=assistant aseq=86 text=好的。\n';
    const lifecycle = '[ws] → event agent run=run-1 stream=lifecycle phase=finishing\n';

    expect(filter.push(first + middle + last + lifecycle)).toBe(
      '[ws] → event agent run=run-1 stream=assistant aseq=71 textChars=1 preview="好"\n' +
        '[ws] → event agent run=run-1 stream=assistant aseq=86 textChars=3 preview="好的。"\n' +
        lifecycle,
    );
  });

  it('buffers interleaved runs independently', () => {
    const filter = new GatewayStdoutLogFilter();
    const mainFirst = '[ws] → event agent run=main-run stream=assistant aseq=2 text=主\n';
    const titleFirst = '[ws] → event agent run=title-run stream=assistant aseq=2 text=标\n';
    const mainLast = '[ws] → event agent run=main-run stream=assistant aseq=20 text=主会话\n';
    const titleLast = '[ws] → event agent run=title-run stream=assistant aseq=3 text=标题\n';
    const titleEnd = '[ws] → event agent run=title-run stream=lifecycle phase=end\n';
    const mainEnd = '[ws] → event agent run=main-run stream=lifecycle phase=end\n';

    expect(filter.push(mainFirst + titleFirst + mainLast + titleLast)).toBe(
      '[ws] → event agent run=main-run stream=assistant aseq=2 textChars=1 preview="主"\n' +
        '[ws] → event agent run=title-run stream=assistant aseq=2 textChars=1 preview="标"\n',
    );
    expect(filter.push(titleEnd + mainEnd)).toBe(
      '[ws] → event agent run=title-run stream=assistant aseq=3 textChars=2 preview="标题"\n' +
        titleEnd +
        '[ws] → event agent run=main-run stream=assistant aseq=20 textChars=3 preview="主会话"\n' +
        mainEnd,
    );
  });

  it('flushes thinking before assistant starts for the same run', () => {
    const filter = new GatewayStdoutLogFilter();
    const thinkingFirst = '[ws] → event agent run=run-1 stream=thinking aseq=2\n';
    const thinkingLast = '[ws] → event agent run=run-1 stream=thinking aseq=23\n';
    const assistantFirst = '[ws] → event agent run=run-1 stream=assistant aseq=29 text=你\n';

    expect(filter.push(thinkingFirst + thinkingLast + assistantFirst)).toBe(
      thinkingFirst +
        thinkingLast +
        '[ws] → event agent run=run-1 stream=assistant aseq=29 textChars=1 preview="你"\n',
    );
  });

  it('keeps a bounded thinking preview when the runtime provides text', () => {
    const filter = new GatewayStdoutLogFilter();
    const text = '思'.repeat(100);
    const first = `[ws] → event agent run=run-1 stream=thinking aseq=2 text=${text}\n`;

    expect(filter.push(first)).toBe(
      `[ws] → event agent run=run-1 stream=thinking aseq=2 textChars=100 preview="${'思'.repeat(80)}…"\n`,
    );
  });

  it('discards chat deltas and periodic health broadcasts', () => {
    const filter = new GatewayStdoutLogFilter();

    expect(
      filter.push(
        '[ws] → event chat seq=per-client dropIfSlow=true\n' +
          '[ws] → event tick seq=broadcast clients=2\n' +
          '[ws] → event health seq=broadcast clients=2\n',
      ),
    ).toBe('');
  });

  it('keeps successful and failed polling responses for frequency diagnostics', () => {
    const filter = new GatewayStdoutLogFilter();
    const success = '[ws] ⇄ res ✓ sessions.list 95ms id=request-1\n';
    const failure = '[ws] ⇄ res ✗ sessions.list error=unavailable id=request-2\n';

    expect(filter.push(success + failure)).toBe(success + failure);
  });

  it('keeps plugin summaries while discarding per-plugin loading lines', () => {
    const filter = new GatewayStdoutLogFilter();
    const loading = '[plugins] loading browser from C:\\runtime\\browser\\index.js\n';
    const summary = '[plugins] loaded 4 plugin(s) (4 attempted) in 30.9ms\n';

    expect(filter.push(loading + summary)).toBe(summary);
  });
});
