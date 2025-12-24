# TypeScript Migration (Pragmatic)

## Why

Weiwudi needs type safety and better developer experience. However, the codebase contains complex logic (especially in `weiwudi_gw_logic.js`) that is difficult to strictly type in one go. A pragmatic, phased approach is required to migrate the build system to TypeScript first, ensuring no functionality is broken, while enabling incremental type improvements.

## What Changes

### 1. Build System Migration
- Install TypeScript and create `tsconfig.json`.
- Update Vite configurations to compile `.ts` files.
- Enable auto-generation of `.d.ts` files.
- Remove manual `index.d.ts`.

### 2. Source File Rename
- Rename all `.js` files in `src/` to `.ts`.
- `weiwudi.js` → `weiwudi.ts`
- `weiwudi_gw.js` → `weiwudi_gw.ts`
- `weiwudi_sw.js` → `weiwudi_sw.ts`
- `weiwudi_gw_logic.js` → `weiwudi_gw_logic.ts`

### 3. Pragmatic Typing
- For simple files (`weiwudi_gw.ts`, `weiwudi_sw.ts`), apply proper types immediately.
- For complex files (`weiwudi_gw_logic.ts`, `weiwudi.ts`), use `// @ts-nocheck` or loose typing (`any`) initially to ensure the build passes.
- Maintain existing runtime behavior 100%.

## Dependencies

- `typescript`
- `@types/node`
- `workbox-core` (for types)

## Breaking Changes

None. Build output remains identical.
