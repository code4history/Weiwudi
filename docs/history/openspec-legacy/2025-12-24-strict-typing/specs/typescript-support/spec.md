# typescript-strict Capability

## Purpose
Ensure all source code adheres to strict TypeScript rules without bypasses.

## MODIFIED Requirements

### Requirement: TypeScript Build Pipeline
The build pipeline MUST rely on strict type checking.

#### Scenario: No Nocheck
Given the source code  
When I search for `// @ts-nocheck`  
Then I should find NO occurrences in `src/`

#### Scenario: Strict Typecheck
Given I run `pnpm run typecheck`  
Then it MUST succeed  
And it MUST validate `weiwudi_gw_logic.ts`
