# Spec: Build System

## ADDED Requirements

### Requirement: Modern Build Tooling
The build environment MUST be migrated from Webpack to Vite. This includes replacing the dev server and the production bundler.

#### Scenario: Dev Server
Given I am a developer
When I run `npm run dev` (or `pnpm dev`)
Then the Vite development server should start
And it should serve the example page (if exists) or the service worker script

#### Scenario: Production Build
Given I am in the CI environment
When I run `npm run build`
Then a production bundle should be generated in `dist/` (or `build/`)
And the output should be minified
And it should include the service worker file

### Requirement: Service Worker Generation
The build process MUST continue to generate a functional Service Worker with precaching capabilities, using modern tools compatible with Vite.

#### Scenario: SW Injection
Given I have a source service worker file
When I build the project
Then a complete service worker with precaching manifest should be generated
And it should work with the existing cache strategies
