declare module 'markdown-it-task-lists' {
  import MarkdownIt from 'markdown-it';
  const plugin: MarkdownIt.PluginWithOptions<{ enabled?: boolean; label?: boolean }>;
  export default plugin;
}
