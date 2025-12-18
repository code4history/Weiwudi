# Design: ESLint Unification

## Context
The project lacks a unified linter. We will introduce ESLint v9.

## Decisions

### 1. ESLint Version
- **Decision**: Use ESLint v9.
- **Rationale**: Latest version, moving to Flat Config by default.

### 2. Configuration Format
- **Decision**: `eslint.config.js`.
- **Rationale**: Native support in v9, replacing `.eslintrc`.
