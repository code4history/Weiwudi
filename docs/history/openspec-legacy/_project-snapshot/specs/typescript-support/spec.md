# typescript-support Specification

## Purpose
TBD - created by archiving change typescriptize. Update Purpose after archive.
## Requirements
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

### Requirement: Incremental Adoption
The project MUST allow some files to bypass strict type checking to facilitate migration.

#### Scenario: Legacy Code Compatibility
Given `weiwudi_gw_logic.ts` contains complex legacy JavaScript  
When strict type checking is enabled globally  
Then this file MAY use `// @ts-nocheck` or broad `any` types  
And the build MUST still proceed

### Requirement: Type Definitions
The project MUST exclude manual type definitions and rely on generated ones.

#### Scenario: No Manual Types
Given the migration is complete  
When I check the project root  
Then `index.d.ts` MUST NOT exist

#### Scenario: Generated Types
Given the build is complete  
When I check `dist/`  
Then `weiwudi.d.ts` (or similar) MUST exist

