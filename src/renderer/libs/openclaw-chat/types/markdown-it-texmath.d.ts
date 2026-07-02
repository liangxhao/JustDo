declare module 'markdown-it-texmath' {
  import type MarkdownIt from 'markdown-it';

  type TexMathOptions = {
    engine: {
      renderToString: (tex: string, options?: Record<string, unknown>) => string;
    };
    delimiters?: string | string[];
    katexOptions?: Record<string, unknown>;
  };

  const markdownItTexMath: (md: MarkdownIt, options: TexMathOptions) => void;
  export default markdownItTexMath;
}
