# CI Pipeline

## ADDED Requirements

### Requirement: Automated Quality Gates

The project SHALL run automated quality checks on every push to any branch.

#### Scenario: Lint check on push
**GIVEN** code is pushed to any branch  
**WHEN** the CI workflow runs  
**THEN** ESLint SHALL execute via `pnpm run lint`  
**AND** the workflow SHALL fail if linting errors are found

#### Scenario: Type check on push
**GIVEN** code is pushed to any branch  
**WHEN** the CI workflow runs  
**THEN** TypeScript type checking SHALL execute via `pnpm run typecheck`  
**AND** the workflow SHALL fail if type errors are found

#### Scenario: Build verification on push
**GIVEN** code is pushed to any branch  
**WHEN** the CI workflow runs  
**THEN** library build SHALL execute via `pnpm run build`  
**AND** demo build SHALL execute via `pnpm run build:demo`  
**AND** the workflow SHALL fail if either build fails

#### Scenario: E2E test execution
**GIVEN** code is pushed to any branch  
**WHEN** the CI workflow runs  
**THEN** Playwright E2E tests SHALL execute via `pnpm test`  
**AND** the workflow SHALL fail if any test fails

### Requirement: Multi-version Node Support

The project SHALL verify compatibility with multiple Node.js versions.

#### Scenario: Node 20 compatibility
**GIVEN** code is pushed to any branch  
**WHEN** the CI workflow runs  
**THEN** all quality checks SHALL run on Node.js 20.x  
**AND** the workflow SHALL report success/failure for Node 20

#### Scenario: Node 22 compatibility
**GIVEN** code is pushed to any branch  
**WHEN** the CI workflow runs  
**THEN** all quality checks SHALL run on Node.js 22.x  
**AND** the workflow SHALL report success/failure for Node 22

### Requirement: pnpm 9 Dependency Management

The project SHALL use pnpm version 9 for package management in CI.

#### Scenario: pnpm installation in CI
**GIVEN** a CI workflow job starts  
**WHEN** dependencies are being installed  
**THEN** pnpm version 9.x SHALL be installed  
**AND** dependencies SHALL be installed via `pnpm install --frozen-lockfile`
