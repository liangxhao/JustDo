/** @vitest-environment jsdom */

import { html, nothing, render } from 'lit';
import { afterEach, expect, test, vi } from 'vitest';

import { disclosureContent, materializeDisclosureContent, materializeDisclosureContents } from './disclosure-content';

afterEach(() => document.body.replaceChildren());

test('prepares an automatic fold without eagerly rendering closed nested tool details', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const tool = vi.fn(() => html`<p>Tool output</p>`);
  render(html`<details>
    <summary>Process</summary>
    <div>${disclosureContent(() => html`<details>
      <summary>Tool</summary><div>${disclosureContent(tool)}</div>
    </details>`)}</div>
  </details>`, host);
  const details = host.querySelector('details')!;
  materializeDisclosureContent(details);
  expect(host.querySelectorAll('details')).toHaveLength(2);
  expect(tool).not.toHaveBeenCalled();
});

test('defers closed Markdown/tool work, renders the latest body on open and retains mounted nodes on close', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const content = vi.fn(
    (text: string) =>
      html`<input value="draft" />
        <p>${text}</p>`,
  );
  const show = (text: string) =>
    render(
      html`<details>
        <summary>Process</summary>
        <div>${disclosureContent(() => content(text))}</div>
      </details>`,
      host,
    );
  show('old');
  show('latest');
  const details = host.querySelector('details')!;
  expect(content).not.toHaveBeenCalled();
  details.querySelector('summary')!.click();
  expect(details.open).toBe(true);
  details.dispatchEvent(new Event('toggle'));
  expect(content).toHaveBeenLastCalledWith('latest');
  const input = host.querySelector('input')!;
  input.value = 'edited';
  details.open = false;
  details.dispatchEvent(new Event('toggle'));
  show('next');
  expect(host.querySelector('input')).toBe(input);
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  expect(input.value).toBe('edited');
  expect(host.textContent).toContain('next');
});

test('explicit search materialization reaches nested closed disclosures and detaches listeners on removal', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const content = vi.fn(() => html`<p>Nested tool detail</p>`);
  render(
    html`<details>
      <summary>Process</summary>
      <div>
        ${disclosureContent(
          () =>
            html`<details>
              <summary>Tool</summary>
              <div>${disclosureContent(content)}</div>
            </details>`,
        )}
      </div>
    </details>`,
    host,
  );
  materializeDisclosureContents(host);
  expect(host.textContent).toContain('Nested tool detail');
  expect([...host.querySelectorAll('details')].every(details => !details.open)).toBe(true);
  const details = host.querySelectorAll('details')[1];
  render(nothing, host);
  content.mockClear();
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  expect(content).not.toHaveBeenCalled();
});
