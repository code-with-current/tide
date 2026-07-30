/**
 * Project template registry — the v1 set of stacks the "New Project → From
 * Template" flow offers. Shared between the renderer (renders the picker) and
 * the backend (runs the scaffold command), so adding a template is one edit.
 *
 * Each template describes how to scaffold into an EMPTY, already-created
 * directory (the dialog creates + `git init`s the parent project dir first,
 * then the scaffold runs inside it). Two command shapes are supported:
 *
 *   - `scaffold`: a single command that creates files AND installs deps
 *     (create-next-app, create-expo-app). Run in the project dir; nothing else.
 *   - `scaffold` + `install`: a create-files-only command followed by a
 *     separate `npm install` step. Used when the official CLI splits the two
 *     (create-vite, create-t3-app --noInstall, nuxi, etc.).
 *
 * Commands are run via `spawn` with argv arrays (no shell) by the backend,
 * so there's no injection surface from the project name. Templates with
 * interactive prompts must pass `--no-...`/`-y`/non-interactive flags so the
 * scaffold never blocks waiting for stdin.
 */

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
    // create-next-app is non-interactive with these flags and installs deps.
    // `--yes` makes it use defaults for any unprovided option (prevents hangs
    // on stdin EOF). `.` scaffolds into the current dir; --skip-install is
    // omitted so deps install as part of the scaffold.
    // NOTE: --no-turbopak/--no-src-dir are NOT valid flags (verified via
    // `create-next-app --help`) — only the positive --src-dir exists, and
    // turbopak isn't a CLI flag at all. Don't re-add them.
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
    // create-vite scaffolds files only; install is a separate step.
    // The `.` target MUST come before `--` (it's a positional arg to
    // create-vite, not a flag). Without it, Vite prompts for a project name
    // and scaffolds into a default `vite-project/` subdir instead of cwd.
    scaffold: ['npm', 'create', 'vite@latest', '.', '--', '--template', 'react-ts'],
    install: ['npm', 'install'],
  },
  {
    id: 'tanstack-start',
    label: 'TanStack Start',
    description: 'Full-stack React with type-safe routing & data loading. The modern type-safe stack.',
    icon: 'layers',
    // The official scaffolder is `create-router` (published as
    // @tanstack/create-router), invoked via `npm create @tanstack/router` or
    // `npx @tanstack/create-router`. It's interactive by default (prompts for
    // bundler + IDE); pass both explicitly + --skip-install (we install as a
    // separate tracked step) + --skip-build (the post-scaffold build adds
    // time and isn't needed for workspace entry).
    // NOTE: do NOT use `@tanstack/router-cli create .` — that's a different
    // tool (the router codegen CLI) which exits 0 but creates nothing.
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
    // create-t3-app is interactive by default (prompts for which packages to
    // include). `--default` (alias -y) bypasses all prompts and uses the
    // defaults (NextAuth + Prisma + tRPC + Tailwind + Next.js App Router).
    // `--noGit` because we git-init ourselves after scaffolding; `--noInstall`
    // because we run `npm install` as a separate tracked step.
    // NOTE: --skipEnvValidation is NOT a create-t3-app flag (it's a Next.js
    // runtime config) — would error. Removed.
    scaffold: ['npx', 'create-t3-app@latest', '.', '--default', '--noGit', '--noInstall'],
    install: ['npm', 'install'],
  },
  {
    id: 'nuxt',
    label: 'Nuxt',
    description: 'The Vue meta-framework. SSR, file routing, auto-imports.',
    icon: 'leaf',
    // nuxi init into `.` (current dir). `--packageManager npm` avoids the
    // interactive package-manager prompt. We DON'T pass --gitInit (we init
    // git ourselves after scaffolding so the .git placement is consistent
    // across templates). NOTE: there is no --no-gitInit flag — only the
    // positive --gitInit, which we simply omit.
    scaffold: ['npx', 'nuxi@latest', 'init', '.', '--packageManager', 'npm'],
    install: ['npm', 'install'],
  },
];

export const TEMPLATES_BY_ID: Record<TemplateId, ProjectTemplate> = Object.fromEntries(
  TEMPLATES.map((t) => [t.id, t]),
) as Record<TemplateId, ProjectTemplate>;
