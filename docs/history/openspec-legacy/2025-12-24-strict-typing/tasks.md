# Tasks: Strict Typing

## Setup
- [ ] Create `strict-typing` branch (if applicable)

## Implementation
- [ ] Type `src/weiwudi_sw.ts` (Simple)
- [ ] Type `src/weiwudi.ts`
  - [ ] Remove `@ts-nocheck`
  - [ ] Fix obvious errors
  - [ ] Define `WeiwudiOptions` interface
- [ ] Type `src/weiwudi_gw_logic.ts` (Granular Migration)
  - [ ] Remove top-level `// @ts-nocheck`
  - [ ] Resolve errors by adding `// @ts-ignore` or `any` to specific lines (Baseline)
  - [ ] Define helper interfaces (`MapSetting`, etc.)
  - [ ] Type `Weiwudi_Internal` signature
  - [ ] Iteratively remove `// @ts-ignore` from independent functions
  - [ ] Verify build passes at each step

## Verification
- [ ] Run `pnpm run typecheck` - MUST PASS without errors
- [ ] Run `pnpm test` - E2E tests MUST PASS
