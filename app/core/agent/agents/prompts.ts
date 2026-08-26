/** Agent prompts loaded from MD files via build-time bundle. Add a .md file in src/lib/prompts/agents/ (frontmatter + prompt) and run build/promptMarkdownUtils.mjs to register it; edit by modifying the .md and rebuilding. */
export { BUNDLED_AGENTS, type BundledAgent } from '../../../../src/lib/prompts/_agent-prompts-bundle';
