# Spec: Linting Standardization

## ADDED Requirements

### Requirement: ESLint Adoption
The project MUST adopt ESLint for code quality and style enforcement.

#### Scenario: Installation
Given I have the project repository
When I check `package.json`
Then `eslint` should be present in `devDependencies`
And the version should be `^9.0.0` or higher

### Requirement: Flat Config
The project MUST use the Flat Config format (`eslint.config.js`) for ESLint configuration.

#### Scenario: Config File
Given I am in the project root
When I list the files
Then `eslint.config.js` should exist
And `.eslintrc` should NOT exist

### Requirement: Lint Script
The project MUST provide a unified script to run the linter.

#### Scenario: Running Lint
Given I have installed dependencies
When I run `npm run lint` (or `pnpm lint`)
Then ESLint should run on the `src` directory
And it should report any violations
