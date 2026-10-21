export function startupPresentationPlugin(rendererRoot: string): {
  name: string;
  transformIndexHtml: {
    order: 'pre';
    handler(html: string): string;
  };
};
