# Repository Guidelines

## Core Operating Principles

These principles govern how an AI coding agent should operate in this repository, regardless of which tool (Claude Code, Codex, or others) is used.

1. **Response Language Discipline**: Follow this repository's working-language convention when responding to the user (for this repository, Japanese), and keep responses polite and concise. This rule governs the language the agent uses when *talking with the user* — it is a separate axis from the language this document itself is written in (English, see "Documentation Language" below), and separate from the bilingual (English/Japanese) convention that applies to README and Wiki pages.
2. **Respect for Existing Behavior**: Do not invent your own implementation or make unsupported leaps of inference. Prioritize faithfully reproducing and porting the logic of the existing implementation — the migration source, the specification, or prior commits — over introducing a novel design.
3. **Root-Cause Analysis**: When a problem or bug occurs, do not keep patching based on guesses. Always compare against the existing implementation or specification and investigate the root cause thoroughly before applying a fix.
4. **The Human Gate Is Sovereign**: Never decide on your own that it is fine to move on to the next step without an explicit response from the user to a question or confirmation request. The agent privately concluding that something is fine is not a substitute for the user confirming it — the user must obtain that assurance for themselves. Whether to proceed to the next step is always the user's exclusive prerogative. Proceeding without a response usurps that prerogative and must be treated as the equivalent of a coup — a grave violation, never a minor process slip.

### Documentation Language

This document (`AGENTS.md`) itself is written in English, independent of principle 1 above.

## Operational Rules & History

- Repository-specific operating rules for AI coding agents are recorded under `docs/superpowers/rules/`.
- A translated index of this repository's pre-2026 development history (proposals and records originally written in the OpenSpec workflow) is available at `docs/history/openspec-legacy-index.md`, with original documents preserved under `docs/history/openspec-legacy/`.

## Project Structure & Module Organization

Service-worker tile-cache logic lives in `src/` (`weiwudi.ts` client API, `weiwudi_sw.ts` service-worker entry, `weiwudi_gw.ts`/`weiwudi_gw_logic.ts` gateway logic). `workbox-config.js` configures the Workbox-based service worker build. Playwright end-to-end specs live in `tests/e2e/` (`cache.spec.js`); there is no separate unit-test suite. `public/` hosts the built service-worker output consumed by the demo/integration pages.

## Build, Test, and Development Commands

`pnpm dev` starts the Vite dev server. `pnpm build` runs three separate Vite configs in sequence (`vite.config.lib.js` for the library bundle, `vite.config.sw-es.js` and `vite.config.sw-umd.js` for the service-worker bundles) and copies the UMD service-worker output into `public/weiwudi-sw.js`. `pnpm build:demo` runs `pnpm build` then `vite build -c vite.config.demo.js`. `pnpm typecheck` runs `tsc --noEmit`. `pnpm test` runs the Playwright suite (this repository has no Vitest unit tests). `pnpm lint` runs ESLint over `src/**/*.ts`. `pnpm preview` serves the built demo locally.

## Coding Style & Naming Conventions

TypeScript with `strict: true` in `tsconfig.json` (no `@/*` path alias in this repository). ESLint is configured via `eslint.config.mjs` (`@typescript-eslint` rules). There is no Prettier configuration file in this repository; match the existing formatting (single quotes, tab-free indentation) already present in `src/`.

## Testing Guidelines

Playwright is the only test framework in this repository (`pnpm test`); specs live in `tests/e2e/` (`cache.spec.js`) and exercise the service-worker cache behavior against a running dev server (`playwright.config.js` starts `webServer` at `http://localhost:5173`). There is no unit-test layer to run separately.

## Commit & Pull Request Guidelines

Recent `git log` shows a mix of subject-only commits, `docs:`-prefixed messages, and task-ID-prefixed messages (e.g. `m15-t1:`, `m14-t2:`, `c2-m4-t3:`) tied to this project's internal task tracking, plus issue-referencing subjects (`#2, #22`). Keep commits scoped to one concern; when a message is not part of a tracked task, prefer a Conventional Commits prefix and reference issue numbers when relevant. Pull requests should describe the cache behavior affected and confirm lint, typecheck, and the Playwright suite pass locally before requesting review.

## Release & Configuration Tips

The service worker is built as three separate bundles (`lib`, `sw-es`, `sw-umd`) and the UMD output is copied into `public/` as part of `pnpm build`; verify `public/weiwudi-sw.js` is up to date after any service-worker change. Keep secrets out of the repository.
