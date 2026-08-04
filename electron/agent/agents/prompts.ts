/**
 * Agent prompts — loaded from MD files via build-time bundle.
 *
 * To add a new agent: create a new .md file in src/lib/prompts/agents/ with
 * frontmatter (name, description, whenToUse) + prompt content. Run the
 * bundler: node build/promptMarkdownUtils.mjs. The agent is automatically
 * registered — no code changes needed.
 *
 * To edit an existing agent: modify its .md file, then rebuild.
 */
export { BUNDLED_AGENTS, type BundledAgent } from '../../../src/lib/prompts/_agent-prompts-bundle';
