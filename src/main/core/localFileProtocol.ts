import { net, protocol } from 'electron';

export const registerLocalFileProtocol = (): void => {
  // Three slashes needed: localfile:///C:/Users/... gives pathname /C:/Users/...
  protocol.handle('localfile', request => {
    const url = new URL(request.url);
    let filePath = decodeURIComponent(url.pathname);
    // Strip leading slash for Windows paths (e.g., /C:/Users/... -> C:/Users/...)
    if (filePath.startsWith('/') && filePath.match(/^\/[A-Za-z]:\//)) {
      filePath = filePath.slice(1);
    }
    return net.fetch(`file://${filePath}`);
  });
};
