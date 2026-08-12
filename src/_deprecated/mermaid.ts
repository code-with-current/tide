/** rehype plugin: intercept mermaid code blocks before Streamdown's Shiki renderer. Replaces `<pre><code class="language-mermaid">` with `<div data-mermaid="...">`, which MemoizedMarkdown's `components.div` mounts as `MermaidDiagram`. */
export function rehypeMermaid() {
  return (tree: any) => {
    if (!tree?.children) return;
    tree.children = tree.children.map((node: any) => {
      if (node.tagName !== 'pre') return node;
      const codeEl = node.children?.[0];
      if (!codeEl || codeEl.tagName !== 'code') return node;
      const classes: string[] = codeEl.properties?.className || [];
      if (!classes.includes('language-mermaid')) return node;

      // Extract the raw mermaid source from the code element's text children.
      const raw = extractText(codeEl);

      // Replace the <pre> with a <div> carrying the encoded source.
      return {
        type: 'element',
        tagName: 'div',
        properties: {
          className: ['mermaid-placeholder'],
          // Base64-encode to survive HTML attribute escaping.
          'data-mermaid': btoa(unescape(encodeURIComponent(raw))),
        },
        children: [],
      };
    });
  };
}

function extractText(node: any): string {
  if (node.type === 'text') return node.value;
  if (node.children) return node.children.map(extractText).join('');
  return '';
}
