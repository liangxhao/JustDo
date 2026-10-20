// @vitest-environment jsdom
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { cleanup, render } from '@testing-library/react';
import React, { createRef } from 'react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';

import { appJsxRuntime } from '../../src/renderer/features/plugins/app/jsxRuntime';

interface Fixture {
  PluginStaticChildren(): React.ReactElement<{ children: React.ReactElement[] }>;
  PluginDynamicChildren: React.ComponentType;
  PluginKeyedChildren: React.ComponentType<{ ids: string[] }>;
  keyedRef(ref: React.Ref<HTMLInputElement>): React.ReactElement;
}
let bundle: string;
let developmentBundle: string;
function evaluate<T>(source: string, overrides: Partial<typeof appJsxRuntime> = {}): T {
  // Evaluate the trusted build output against a local bridge object, without
  // mutating the application's immutable global singleton or bundling React.
  return new Function('globalThis', `${source}; return PluginFixture;`)({
    [Symbol.for('app-plugin.browser-runtime.v1')]: { React, ...appJsxRuntime, ...overrides },
  }) as T;
}
beforeAll(async () => {
  const fixtures = {
    normal: `
        export function PluginStaticChildren(){return <section><span>First</span><span>Second</span></section>;}
        export function PluginDynamicChildren(){const children=[<span>First</span>,<span>Second</span>];return <aside>{children}</aside>;}
        export function PluginKeyedChildren({ids}){return <div>{ids.map(id=><input key={id} defaultValue={id}/>)}</div>;}
        export function keyedRef(ref){return <input key={7} ref={ref}/>;}
      `,
    development: "export {jsxDEV as create} from 'react/jsx-dev-runtime';",
  };
  // Build in a real Node realm. jsdom's TextEncoder/Uint8Array identities are
  // intentionally separate; do not replace those globals to satisfy esbuild.
  const source = `
    import {build} from 'esbuild';
    import {browserSdk} from './scripts/plugins/build-app-plugins.mjs';
    const fixtures=JSON.parse(process.argv[1]);
    const compile=async(contents,loader)=>{
      const result=await build({
        stdin:{contents,loader,sourcefile:'plugin-jsx-fixture.'+loader},
        write:false,bundle:true,platform:'browser',format:'iife',globalName:'PluginFixture',
        jsx:'automatic',plugins:[browserSdk],logLevel:'silent',
      });
      return result.outputFiles[0].text;
    };
    const normal=await compile(fixtures.normal,'tsx');
    const development=await compile(fixtures.development,'js');
    process.stdout.write(JSON.stringify({normal,development}));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', source, JSON.stringify(fixtures)],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  const built = JSON.parse(stdout) as { normal: string; development: string };
  bundle = built.normal;
  developmentBundle = built.development;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('real compiled static siblings preserve React static-child semantics without manufacturing keys', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { PluginStaticChildren } = evaluate<Fixture>(bundle);
  expect(PluginStaticChildren().props.children.map(child => child.key)).toEqual([null, null]);
  const view = render(<PluginStaticChildren />);
  expect(view.container.querySelectorAll('span')).toHaveLength(2);
  expect(view.container.textContent).toBe('FirstSecond');
  expect(errors).not.toHaveBeenCalled();
});

test('a real dynamic array without keys still produces React key validation', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { PluginDynamicChildren } = evaluate<Fixture>(bundle);
  render(<PluginDynamicChildren />);
  expect(errors.mock.calls.some(args => String(args[0]).includes('Each child in a list'))).toBe(
    true,
  );
});

test('explicit keys preserve element identity on reorder and refs use the real JSX special-prop semantics', () => {
  const { PluginKeyedChildren, keyedRef } = evaluate<Fixture>(bundle);
  const view = render(<PluginKeyedChildren ids={['first', 'second']} />);
  const inputs = [...view.container.querySelectorAll('input')];
  inputs[0].value = 'User edit';
  view.rerender(<PluginKeyedChildren ids={['second', 'first']} />);
  const reordered = [...view.container.querySelectorAll('input')];
  expect(reordered[0]).toBe(inputs[1]);
  expect(reordered[1]).toBe(inputs[0]);
  expect(reordered[1].value).toBe('User edit');
  const ref = createRef<HTMLInputElement>();
  const element = keyedRef(ref);
  expect(element.key).toBe('7');
  view.rerender(element);
  expect(ref.current).toBe(view.container.querySelector('input'));
});

test('development runtime forwards its static flag, source and self alongside the original key and props', () => {
  const dev = vi.fn(appJsxRuntime.jsxDEV);
  const { create } = evaluate<{ create: typeof appJsxRuntime.jsxDEV }>(developmentBundle, {
    jsxDEV: dev,
  });
  const props = {
    children: [
      appJsxRuntime.jsx('span', { children: 'First' }),
      appJsxRuntime.jsx('span', { children: 'Second' }),
    ],
  };
  const source = { fileName: 'fixture.tsx', lineNumber: 8, columnNumber: 3 };
  const self = {};
  const element = create('section', props, 'provided-key', true, source, self);
  expect(dev).toHaveBeenCalledExactlyOnceWith('section', props, 'provided-key', true, source, self);
  expect(element.key).toBe('provided-key');
});
