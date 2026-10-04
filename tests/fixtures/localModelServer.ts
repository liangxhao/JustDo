import { createServer, type IncomingHttpHeaders } from 'node:http';

/** Loopback-only fake provider. No external model, credentials or persistent state. */
export async function startLocalModelServer() {
  const requests: Array<{ path: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const requestPath = request.url ?? '';
    requests.push({ path: requestPath, headers: request.headers, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && requestPath === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'local-chat' }, { id: 'local-embedding' }] }));
    } else if (request.method === 'GET' && requestPath === '/v1/model/info') {
      response.end(JSON.stringify({ data: [
        { model_name: 'local-chat', model_info: { mode: 'chat' } },
        { model_name: 'local-embedding', model_info: { mode: 'embedding' } },
      ] }));
    } else if (request.method === 'POST' && requestPath === '/v1/chat/completions') {
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'local fixture reply' }, finish_reason: 'stop' }] }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
