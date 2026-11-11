import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { expect, test } from 'vitest';

import { decodeRelocationNativeFailure, NATIVE_RELOCATION_FAILURE_DETAILS } from './relocationNativeFailure';

const extract = runInNewContext(`${NATIVE_RELOCATION_FAILURE_DETAILS}\nrelocationNativeFailureDetails`, { path }) as (
  failure: unknown, roots: string[], fallbackCode?: string,
) => { code?: string; path?: string };
const root = path.resolve('migration-profile');
const file = path.join(root, 'state.sqlite');

test('extracts an exact scoped path and lock code from the same underlying error', () => {
  const cause = Object.assign(new Error('untrusted native text'), { code: 'EBUSY', path: file });
  const wrapped = new Error('internal operation details', { cause });

  expect(extract(wrapped, [root])).toEqual({ code: 'EBUSY', path: file });
  expect(extract(new AggregateError([
    { code: 'EACCES' }, { path: file },
  ]), [root])).toEqual({ code: 'EACCES' });
});

test('keeps pathless SQLite diagnostics and rejects external or guessed paths', () => {
  expect(extract({ code: 'ERR_SQLITE_ERROR', errcode: 5, message: `locked ${file}` }, [root]))
    .toEqual({ code: 'SQLITE_BUSY' });
  expect(extract({ code: 'EPERM', path: path.resolve('external.sqlite') }, [root]))
    .toEqual({ code: 'EPERM' });
  expect(extract({ message: `EBUSY ${file}` }, [root])).toEqual({});
});

test('decodes only scoped paths and keeps a fixed error message in Main', () => {
  const message = 'Native relocation failed.';
  expect(decodeRelocationNativeFailure(message, { code: 'EPERM', path: file, message: 'hidden text' }, [root]))
    .toMatchObject({ message, code: 'EPERM', path: file });
  expect(decodeRelocationNativeFailure(message, { code: 'EPERM', path: path.resolve('external.sqlite') }, [root]).path)
    .toBeUndefined();
  expect(decodeRelocationNativeFailure(message, { code: 'ENOSPC', path: file }, [root], ['ENOSPC']))
    .toMatchObject({ message, code: 'ENOSPC' });
  expect(decodeRelocationNativeFailure(message, { code: 'EBUSY', path: `${file}\nother` }, [root]).path)
    .toBeUndefined();
});
