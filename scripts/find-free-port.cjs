const net = require('net');

const canListen = port =>
  new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true));
    });
  });

const findFreePort = async preferredPort => {
  if (await canListen(preferredPort)) return preferredPort;

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
};

module.exports = { findFreePort };
