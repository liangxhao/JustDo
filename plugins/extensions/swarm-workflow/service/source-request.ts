import { createHash } from 'node:crypto';

const HISTORY_PAGE_LIMIT = 20;
const MAX_HISTORY_PAGES = 50;

type HistoryPage = {
  messages: Array<Record<string, unknown>>;
  hasMore: boolean;
  nextOffset?: unknown;
  totalMessages?: unknown;
  sessionId?: unknown;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function parsePage(value: unknown): HistoryPage {
  if (
    !record(value) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(record) ||
    (value.hasMore !== undefined && typeof value.hasMore !== 'boolean')
  )
    throw new Error('Invalid native workflow source history page.');
  return {
    messages: value.messages,
    hasMore: value.hasMore === true,
    nextOffset: value.nextOffset,
    totalMessages: value.totalMessages,
    sessionId: value.sessionId,
  };
}

function totalMessages(page: HistoryPage): number {
  if (!Number.isSafeInteger(page.totalMessages) || Number(page.totalMessages) < 0)
    throw new Error('Native workflow source history has no stable message count.');
  return Number(page.totalMessages);
}

function headFingerprint(page: HistoryPage): string {
  // Retain only a digest while paging, never another copy of transcript text.
  return createHash('sha256')
    .update(JSON.stringify([page.messages, page.hasMore, page.nextOffset, page.sessionId]))
    .digest('hex');
}

/** Read the newest user through the public history API without assuming a stable offset snapshot. */
export async function readLatestWorkflowUser({
  sessionKey,
  rpc,
  assertCurrent,
}: {
  sessionKey: string;
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  assertCurrent: () => void;
}): Promise<Record<string, unknown> | undefined> {
  const read = async (offset = 0): Promise<HistoryPage> => {
    assertCurrent();
    let value: unknown;
    try {
      value = await rpc('chat.history', {
        sessionKey,
        limit: HISTORY_PAGE_LIMIT,
        ...(offset > 0 ? { offset } : {}),
      });
    } finally {
      assertCurrent();
    }
    return parsePage(value);
  };
  let page = await read();
  let latest = [...page.messages].reverse().find(message => message.role === 'user');
  if (latest || !page.hasMore) {
    assertCurrent();
    return latest;
  }

  const initialTotal = totalMessages(page);
  const initialHead = headFingerprint(page);
  const checkHead = async () => {
    const current = await read();
    if (totalMessages(current) !== initialTotal || headFingerprint(current) !== initialHead)
      throw new Error('Native workflow source history changed while reading the current request.');
  };
  let offset = 0;
  let pages = 1;
  while (page.hasMore) {
    if (pages >= MAX_HISTORY_PAGES)
      throw new Error('Native workflow source history exceeded the request lookup budget.');
    const nextOffset = page.nextOffset;
    if (
      !Number.isSafeInteger(nextOffset) ||
      Number(nextOffset) <= offset ||
      Number(nextOffset) >= initialTotal
    )
      throw new Error('Invalid native workflow source history pagination offset.');
    offset = Number(nextOffset);
    page = await read(offset);
    pages++;
    if (totalMessages(page) !== initialTotal)
      throw new Error('Native workflow source history changed while reading the current request.');
    latest = [...page.messages].reverse().find(message => message.role === 'user');
    // A concurrent append shifts every numeric offset. Recheck the live head
    // after each older page, including the page whose user would be returned.
    await checkHead();
    if (latest || !page.hasMore) {
      assertCurrent();
      return latest;
    }
  }
  return undefined;
}
