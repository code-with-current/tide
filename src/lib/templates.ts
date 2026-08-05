/** Project template registry for "New Project → From Template" flow. Commands run via spawn (no shell). */

export type TemplateId = 'empty' | 'nextjs' | 'vite-react' | 'tanstack-start' | 't3' | 'nuxt';

export interface ProjectTemplate {
  id: TemplateId;
  /** Display name in the picker. */
  label: string;
  /** One-line description of what gets created. */
  description: string;
  /** Lucide-style glyph key — the renderer maps this to an icon component.
   *  Kept as a string (not a React node) so the registry is process-agnostic. */
  icon: 'folder' | 'globe' | 'zap' | 'layers' | 'box' | 'leaf';
  /** The scaffold command (argv[0]) — always `npx` or `npm`. */
  scaffold: string[];
  /** Optional separate install step run after scaffold. Omit when the
   *  scaffold command already installs deps. */
  install?: string[];
}

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: 'empty',
    label: 'Empty',
    description: 'Just a git-initialized folder. Bring your own stack.',
    icon: 'folder',
    // No scaffold — the dialog's mkdir + git init is all that runs.
    scaffold: [],
  },
  {
    id: 'nextjs',
    label: 'Next.js',
    description: 'App Router · TypeScript · Tailwind CSS · ESLint. The dominant full-stack React framework.',
    icon: 'globe',
    // create-next-app: --yes uses defaults (prevents stdin EOF hang), . scaffolds into cwd, deps install inline (--skip-install omitted).
    // NOTE: --no-turbopak/--no-src-dir are NOT valid flags — only the positive --src-dir exists, and turbopak isn't a CLI flag at all. Don't re-add them.
    scaffold: [
      'npx', 'create-next-app@latest', '.',
      '--ts', '--tailwind', '--eslint', '--app',
      '--import-alias', '@/*', '--use-npm', '--yes',
    ],
  },
  {
    id: 'vite-react',
    label: 'Vite + React',
    description: 'Lightweight SPA starter. Fastest cold-start, most flexible frontend.',
    icon: 'zap',
    // create-vite: scaffolds files only (install is a separate step), `.` targets cwd (must precede `--`; it's positional, not a flag).
    // NOTE: without the leading `.`, Vite prompts for a project name and scaffolds into a default `vite-project/` subdir instead of cwd.
    scaffold: ['npm', 'create', 'vite@latest', '.', '--', '--template', 'react-ts'],
    install: ['npm', 'install'],
  },
  {
    id: 'tanstack-start',
    label: 'TanStack Start',
    description: 'Full-stack React with type-safe routing & data loading. The modern type-safe stack.',
    icon: 'layers',
    // create-router (@tanstack/create-router): interactive by default — pass bundler + IDE explicitly, --skip-install (separate tracked step), --skip-build (not needed for workspace entry).
    // NOTE: do NOT use `@tanstack/router-cli create .` — different tool (router codegen CLI) that exits 0 but creates nothing.
    scaffold: [
      'npx', '@tanstack/create-router@latest', '.',
      '--package-manager', 'npm', '--bundler', 'vite', '--ide', 'other',
      '--skip-install', '--skip-build',
    ],
    install: ['npm', 'install'],
  },
  {
    id: 't3',
    label: 'T3 Stack',
    description: 'Next.js · tRPC · Prisma · Tailwind · NextAuth. Opinionated, batteries-included.',
    icon: 'box',
    // create-t3-app: --default bypasses prompts (NextAuth + Prisma + tRPC + Tailwind + Next.js App Router); --noGit (we git-init ourselves), --noInstall (separate tracked step).
    // NOTE: --skipEnvValidation is NOT a create-t3-app flag (it's a Next.js runtime config) — would error. Don't re-add.
    scaffold: ['npx', 'create-t3-app@latest', '.', '--default', '--noGit', '--noInstall'],
    install: ['npm', 'install'],
  },
  {
    id: 'nuxt',
    label: 'Nuxt',
    description: 'The Vue meta-framework. SSR, file routing, auto-imports.',
    icon: 'leaf',
    // nuxi init: `.` targets cwd, --packageManager npm avoids the interactive prompt; --gitInit omitted (we git-init ourselves for consistent .git placement across templates).
    // NOTE: there is no --no-gitInit flag — only the positive --gitInit, which we simply omit.
    scaffold: ['npx', 'nuxi@latest', 'init', '.', '--packageManager', 'npm'],
    install: ['npm', 'install'],
  },
];

export const TEMPLATES_BY_ID: Record<TemplateId, ProjectTemplate> = Object.fromEntries(
  TEMPLATES.map((t) => [t.id, t]),
) as Record<TemplateId, ProjectTemplate>;
