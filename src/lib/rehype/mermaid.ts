/**
 * rehype plugin: intercept mermaid code blocks BEFORE Streamdown's
 * Shiki code renderer sees them. Finds `<pre><code class="language-mermaid">`
 * in the HTML AST and replaces the entire `<pre>` with a plain `<div>`
 * carrying the raw mermaid source as a data attribute.
 *
 * Without this, Streamdown's built-in code renderer intercepts fenced
 * code blocks at the component level, and react-markdown's
 * `components.code` override never fires for them.
 *
 * The `<div data-mermaid="...">` is then rendered by the `components.div`
 * override in MemoizedMarkdown, which mounts the MermaidDiagram component.
 */
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
