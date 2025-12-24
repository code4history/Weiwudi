# Implementation Tasks

## Phase 1: Setup & Rename
- [x] Install dependencies (`typescript`, `@types/node`, `workbox-core`)
- [x] Create `tsconfig.json` (strict mode, but allowed to be bypassed via comments)
- [x] Rename all `src/*.js` files to `.ts`
- [x] Update imports to remove `.js` extensions where necessary

## Phase 2: Build Configuration
- [x] Update `vite.config.lib.js` to use `.ts` entry
- [x] Update `vite.config.sw.js` to use `.ts` entries
- [x] Update `package.json` scripts and types field
- [x] Remove manual `index.d.ts`

## Phase 3: Unblock Compilation
- [x] Fix critical import/export errors in `.ts` files
- [x] Apply `// @ts-nocheck` to `src/weiwudi_gw_logic.ts` to bypass complex type errors
- [x] Apply minimal types to `src/weiwudi.ts` (or use `@ts-nocheck` if needed)
- [x] Verify `pnpm run build` succeeds
- [x] Verify `pnpm run typecheck` succeeds (ignoring nocheck files)

## Phase 4: Verification
- [x] Run E2E tests (`pnpm test`) - MUST PASS
- [x] Verify demo site functionality
