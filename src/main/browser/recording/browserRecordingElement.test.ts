// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { isSensitiveRecordingField } from '../../../shared/browser/browserRecording';
import { createRecordingElementDescriber } from './browserRecordingElement';

const { describe: inspect } = createRecordingElementDescriber(e =>
  isSensitiveRecordingField(`${e.getAttribute('type')} ${e.getAttribute('name')}`),
);
beforeEach(() => {
  document.body.innerHTML = '';
});
describe('bounded element evidence', () => {
  it('prefers tested attributes and validates candidates against the target', () => {
    document.body.innerHTML =
      '<button data-testid="save"><span>Save</span></button><button>Save</button>';
    const button = document.querySelector('button')!;
    const result = inspect(button);
    expect(result.selector).toBe('button[data-testid="save"]');
    expect(result.role).toBe('button');
    expect(result.html).toContain('<span>Save</span>');
    expect(result.locators).toContainEqual(expect.objectContaining({ kind: 'role', matches: 2 }));
    for (const candidate of result.locators!.filter(l => l.kind === 'css'))
      expect([...document.querySelectorAll(candidate.value)]).toContain(button);
  });
  it('does not claim duplicate ids are unique', () => {
    document.body.innerHTML = '<button id="same">A</button><button id="same">B</button>';
    const target = document.querySelectorAll('button')[1];
    const result = inspect(target);
    expect(document.querySelectorAll(result.selector)).toHaveLength(1);
    expect(document.querySelector(result.selector)).toBe(target);
  });
  it('retains labelled state and row context without copying passwords or scripts', () => {
    document.body.innerHTML =
      '<form><label for="q">Query</label><input id="q" name="q" value="ordinary"><input type="password" value="secret"><script>secretScript()</script><button>Go</button></form>';
    const input = inspect(document.querySelector('#q')!);
    expect(input.name).toBe('Query');
    expect(input.state?.value).toBe('ordinary');
    expect(input.context?.[0].tag).toBe('form');
    const form = inspect(document.querySelector('form')!);
    expect(JSON.stringify(form)).not.toContain('secret');
    expect(form.html).not.toContain('<script');
  });
  it('tracks a nested open shadow host path and scoped aria labels', () => {
    const host = document.createElement('div');
    host.id = 'host';
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span id="label">Run</span><button aria-labelledby="label">Icon</button>';
    const result = inspect(shadow.querySelector('button')!);
    expect(result.name).toBe('Run');
    expect(result.scopes).toEqual([{ kind: 'shadow', selector: 'div[id="host"]' }]);
  });
  it('records a same-origin frame locator outside the element selector', () => {
    const frame = document.createElement('iframe');
    frame.id = 'embedded';
    document.body.append(frame);
    frame.contentDocument!.body.innerHTML = '<button>Run</button>';
    const result = inspect(frame.contentDocument!.querySelector('button')!);
    expect(result.scopes?.[0]).toMatchObject({ kind: 'frame', selector: 'iframe[id="embedded"]' });
  });
  it('bounds complete HTML and reports truncation', () => {
    document.body.innerHTML = '<section>' + '<span>Some content</span>'.repeat(80) + '</section>';
    const result = inspect(document.querySelector('section')!);
    expect(result.html!.length).toBeLessThanOrEqual(4800);
    expect(result.html).toMatch(/<\/section>$/);
    expect(result.limitations).toContain('html-truncated');
  });
  it('does not cut a huge attribute into an invalid selector', () => {
    const button = document.createElement('button');
    button.id = 'a'.repeat(1800);
    document.body.append(button);
    const result = inspect(button);
    expect(document.querySelector(result.selector)).toBe(button);
    expect(result.selector.length).toBeLessThanOrEqual(1000);
  });
  it('labels custom elements with unavailable internals honestly', () => {
    const host = document.createElement('custom-widget');
    document.body.append(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<button>Invisible</button>';
    expect(inspect(host).limitations).toContain('shadow-unavailable');
  });
});
