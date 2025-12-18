# Design: Vite and pnpm Migration

## Context
The current project uses Webpack 4 with Babel and npm. It relies on `workbox-webpack-plugin` for Service Worker generation.

## Decisions

### 1. Build System: Vite
- **Rationale**: faster startup, native ESM support during dev, easy configuration.
- **Migration**:
    - Remove `webpack`, `webpack-cli`, `babel-loader` (Vite uses esbuild/native).
    - Add `vite`.
    - Handle Service Worker: Use `vite-plugin-pwa` or continue using `workbox-build` / `workbox-cli` if custom logic is complex. Given `weiwudi` is a generic Service Worker for tile cache, we need to ensure the build output structure is preserved or the consumption side is updated. *Assumption*: Output structure should ideally remain compatible or be clearly documented as a breaking change.

### 2. Package Manager: pnpm
- **Rationale**: Speed, disk efficiency, strict dependencies (avoids phantom deps).
- **Migration**:
    - Remove `package-lock.json`.
    - Run `pnpm import` or just `pnpm install`.
    - Update `package.json` scripts.

### 3. Workbox Update
- Current: Workbox 6.0.2.
- Target: Latest Workbox (v7+).
- Note: Check for breaking changes in Workbox 7.

## Constraints
- Must maintain functionality of "Service Worker for tile cache".
- Browser compatibility: Vite targets modern browsers by default using `<script type="module">`. If legacy browser support (IE11) is strictly required, `@vitejs/plugin-legacy` is needed. *Assumption*: Modern browsers are the primary target given the nature of the tool, but we will check `tools` or `browserslist` if available.
