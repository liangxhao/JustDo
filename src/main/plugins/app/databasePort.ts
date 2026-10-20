import type Database from 'better-sqlite3';

/** Preserve the real SQLite connection and transaction while fencing delayed business frames. */
export function createAppDatabasePort(
  database: Database.Database,
  assertEffect: (write?: boolean) => void,
): Database.Database {
  const statements = new WeakMap<object, object>();
  const wrapStatement = (statement: Database.Statement): Database.Statement => {
    const existing = statements.get(statement);
    if (existing) return existing as Database.Statement;
    const view = new Proxy(Object.create(null) as Database.Statement, {
      get(_target, key) {
        if (key === 'database') return port;
        const target = statement;
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          assertEffect(!statement.readonly);
          const result: unknown = Reflect.apply(value, target, args);
          if (result === target) return view;
          if (key === 'iterate' && result && typeof result === 'object') {
            const iterator = result as IterableIterator<unknown>;
            return {
              next: (...input: [] | [unknown]) => {
                assertEffect(!statement.readonly);
                return iterator.next(...input);
              },
              return: () => iterator.return?.() ?? { done: true, value: undefined },
              [Symbol.iterator]() {
                return this;
              },
            };
          }
          return result;
        };
      },
    });
    statements.set(statement, view);
    return view;
  };
  const transactions = new WeakMap<Database.Transaction, Database.Transaction>();
  const wrapTransaction = (transaction: Database.Transaction): Database.Transaction => {
    const existing = transactions.get(transaction);
    if (existing) return existing;
    const callable = function (this: unknown, ...args: unknown[]) {
      assertEffect(true);
      return Reflect.apply(transaction, this, args);
    } as Database.Transaction;
    transactions.set(transaction, callable);
    Object.defineProperty(callable, 'database', { get: () => port });
    for (const variant of ['default', 'deferred', 'immediate', 'exclusive'] as const) {
      Object.defineProperty(callable, variant, {
        get: () => wrapTransaction(transaction[variant] as Database.Transaction),
      });
    }
    return callable;
  };
  const port = new Proxy(Object.create(null) as Database.Database, {
    get(_target, key) {
      const target = database;
      if (['close', 'loadExtension', 'unsafeMode', 'backup'].includes(String(key)))
        return () => {
          throw new Error('appPluginInvalidRequest');
        };
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assertEffect(key !== 'prepare' && key !== 'transaction');
        const result: unknown = Reflect.apply(value, target, args);
        if (key === 'prepare') return wrapStatement(result as Database.Statement);
        if (key === 'transaction') return wrapTransaction(result as Database.Transaction);
        return result === target ? port : result;
      };
    },
  });
  return port;
}
