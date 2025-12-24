# Design: Pragmatic TypeScript Migration

## Strategy

The goal is **Build Migration First, Type Safety Second**. 
We prioritize switching the build pipeline to TypeScript and ensuring the application still runs and builds correctly. We accept "lax" typing (using `any` or `@ts-nocheck`) for existing complex legacy code to avoid a long "refactoring paralysis".

## Architecture

### Source Structure
No structural changes. Files are simply renamed.

### Build Pipeline
Vite is already using esbuild, which handles TS transpilation efficiently. We just need to point it to `.ts` files. 
Type generation (`dts` plugin or `tsc`) becomes the source of truth for library consumers.

### Type Safety Levels

1.  **Strict**: New code (future)
2.  **Basic**: `weiwudi_gw.ts`, `weiwudi_sw.ts` (Import/Export types only)
3.  **Loose/Nocheck**: `weiwudi_gw_logic.ts` (Legacy logic) - Marked with `@ts-nocheck` to allow build.
4.  **Loose**: `weiwudi.ts` - Basic public API typing, looseness for internals to match JS flexible behavior.

## Rollback
If build fails or tests fail, revert renaming and restore `tsconfig.json` deletion.
