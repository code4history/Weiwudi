# demo-deployment Specification

## Purpose
TBD - created by archiving change cicd-ready. Update Purpose after archive.
## Requirements
### Requirement: Demo Build Output

The project SHALL generate a deployable demo site from source.

#### Scenario: Demo build script
**GIVEN** the project has a demo site (index.html)  
**WHEN** `pnpm run build:demo` is executed  
**THEN** a complete demo site SHALL be output to `dist-demo/`  
**AND** the output SHALL include index.html, built libraries, and all assets  
**AND** the demo SHALL function identically to `pnpm dev`

#### Scenario: Demo build independence
**GIVEN** `pnpm run build:demo` has been run  
**WHEN** the `dist-demo/` directory is served via HTTP  
**THEN** the demo site SHALL load without requiring build tools  
**AND** the demo SHALL work offline after initial load

### Requirement: GitHub Pages Deployment

The project SHALL automatically deploy the demo site to GitHub Pages on master branch updates.

#### Scenario: Master branch deployment
**GIVEN** code is pushed to the `master` branch  
**WHEN** the deployment workflow runs  
**THEN** the demo SHALL be built via `pnpm run build:demo`  
**AND** `dist-demo/` SHALL be deployed to GitHub Pages  
**AND** the site SHALL be accessible at the configured GitHub Pages URL

#### Scenario: Non-master branch deployment skip
**GIVEN** code is pushed to a non-master branch  
**WHEN** the deployment workflow condition is evaluated  
**THEN** the deployment workflow SHALL NOT run  
**AND** GitHub Pages SHALL NOT be updated

### Requirement: Build Artifact Exclusion

The project SHALL exclude demo build artifacts from version control.

#### Scenario: Gitignore demo output
**GIVEN** the `.gitignore` file exists  
**WHEN** `dist-demo/` is created by the build  
**THEN** the `dist-demo/` directory SHALL be ignored by git  
**AND** demo artifacts SHALL NOT be committed to the repository

