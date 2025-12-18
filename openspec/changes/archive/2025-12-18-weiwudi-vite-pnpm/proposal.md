# Proposal: Migrate to Vite and pnpm

- **Change ID**: `weiwudi-vite-pnpm`
- **Status**: `Proposed`
- **Outcome**: Modernize build system and package management.

## Summary
Migrate the legacy Webpack 4 build system to Vite for improved performance and maintainability. Adopt pnpm for efficient dependency management and stricter resolution. Update usage of `workbox` to the latest version compatible with Vite (using `vite-plugin-pwa` or similar if needed, or keeping `workbox-cli` but orchestrated via pnpm scripts).

## Motivation
- **Issue #23**: Webpack 4 is outdated and slow. Vite provides a faster dev server and optimized builds.
- **Issue #24**: Dependency updates and security. pnpm offers better disk usage and monorepo readiness.
- **Modernization**: Align with modern web development standards.

## Artifacts
- `tasks.md`: Execution plan.
- `design.md`: Technical decisions and trade-offs.
- `specs/`: Detailed requirement changes.
