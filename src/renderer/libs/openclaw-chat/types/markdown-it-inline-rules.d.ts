declare module 'markdown-it/lib/rules_inline/link.mjs' {
  import type { RuleInline } from 'markdown-it/lib/parser_inline.mjs';
  const link: RuleInline;
  export default link;
}

declare module 'markdown-it/lib/rules_inline/backticks.mjs' {
  import type { RuleInline } from 'markdown-it/lib/parser_inline.mjs';
  const backticks: RuleInline;
  export default backticks;
}
