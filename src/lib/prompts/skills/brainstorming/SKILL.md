---
name: "brainstorming"
description: "Use this before any creative work — creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."
---
<!-- Adapted from obra/superpowers (MIT) — https://github.com/obra/superpowers -->

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context (files, docs, recent commits), then ask questions one at a time to refine the idea. Once you understand what's being built, present the design in small sections, checking after each section whether it looks right so far.

## The Process

**Understanding the idea:**
- Check the current project state first — read_file, grep, git log
- Ask questions one at a time; prefer multiple choice when possible
- Focus on: purpose, constraints, success criteria

**Exploring approaches:**
- Propose 2-3 approaches with trade-offs
- Lead with your recommendation and why

**Presenting the design:**
- Break it into sections of 200-300 words
- Ask after each section whether it looks right
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify

## Visual Companion

Keep a living HTML file at `docs/plans/design-companion.html` so the user can watch the design take shape. Create it after the first validated section and update it after every subsequent section. Rules:

- Self-contained single file: inline CSS, **inline SVG only — no external URLs, no images loaded from the network, no CDNs**
- Shows: the idea, questions asked so far, options considered, the current validated design state (append sections as they're approved)
- The user opens it in a browser; mention the path whenever you update it

## After the Design

- Write the validated design to `docs/plans/YYYY-MM-DD-<topic>-design.md`
- Ask: "Ready to set up for implementation?"
- If yes: load the `writing-plans` skill (load_skill), and `using-git-worktrees` for an isolated workspace

## Key Principles

- **One question at a time** — don't overwhelm
- **Multiple choice preferred**
- **YAGNI ruthlessly** — cut unnecessary features from all designs
- **Explore alternatives** — always 2-3 approaches before settling
- **Incremental validation** — section by section
