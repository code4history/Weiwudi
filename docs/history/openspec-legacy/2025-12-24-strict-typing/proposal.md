# Strict TypeScript Migration

## Why

The initial TypeScript migration used a pragmatic approach (`// @ts-nocheck`) to unblock the build system migration. To realize the full benefits of TypeScript (type safety, better DX, bug prevention), we must remove these bypasses and strictly type the codebase.

## What Changes

### 1. Remove Bypasses
- Remove `// @ts-nocheck` from `src/weiwudi_gw_logic.ts`.
- Remove `// @ts-nocheck` from `src/weiwudi.ts`.
- Remove manual `any` casts in `src/weiwudi_sw.ts`.

### 2. Implement Strict Types
- **Generic Types**: Define interfaces for `MapOptions`, `CacheStats`, `TileConfig`, etc.
- **Service Worker Types**: Properly type `ServiceWorkerGlobalScope` and Workbox interactions.
- **Legacy Logic**: Refactor or explicitly type complex legacy patterns in `weiwudi_gw_logic.ts`.

## Dependencies
- No new runtime dependencies.
- May require deeper refactoring of `weiwudi_gw_logic` if certain patterns are untypeable.
