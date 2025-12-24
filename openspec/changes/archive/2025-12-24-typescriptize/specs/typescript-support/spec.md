# typescript-support Specification

## Purpose
Migrate the codebase to TypeScript to enable better tooling and future type safety, without breaking existing functionality or blocking on complex legacy code typing.

## ADDED Requirements

### Requirement: TypeScript Build Pipeline
The project MUST compile TypeScript source files to JavaScript bundles.

#### Scenario: Build Success
Given the source files are renamed to `.ts`  
And `tsconfig.json` is configured  
When I run `pnpm run build`  
Then it MUST succeed without errors  
And `dist/` MUST contain valid JavaScript bundles

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
