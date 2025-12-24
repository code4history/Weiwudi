# e2e-testing Specification

## Purpose
Provides automated end-to-end testing of Weiwudi's tile caching capabilities using Playwright in a real browser environment.

## ADDED Requirements

### Requirement: Playwright Test Infrastructure
The project MUST include Playwright-based E2E tests that verify Service Worker functionality in a real browser environment.

#### Scenario: Test Execution
Given I have installed dependencies  
When I run `pnpm run test:e2e`  
Then Playwright should execute all E2E tests  
And all tests should pass  
And a test report should be generated

### Requirement: Service Worker Registration Testing
The test suite MUST verify that the Weiwudi Service Worker can be registered and activated successfully.

#### Scenario: SW Registration
Given I have a test page with Weiwudi library  
When the page registers the Service Worker  
Then the Service Worker should activate within 5 seconds  
And the SW should be in 'activated' state

### Requirement: Tile Caching Verification
The test suite MUST verify that tile URLs are cached correctly when accessed.

#### Scenario: Cache Tile Requests
Given the Service Worker is active  
When a tile URL is requested (e.g., `/tiles/0/0/0.png`)  
Then the tile should be cached in IndexedDB  
And subsequent requests should be served from cache

#### Scenario: Cache Statistics
Given tiles have been cached  
When I call `map.stats()`  
Then it should return cache statistics  
And statistics should include tile count and byte size

### Requirement: Cache Clearing Capability
The test suite MUST verify that cached tiles can be cleared on demand.

#### Scenario: Clear All Tiles
Given tiles are cached for a registered map  
When I call `map.clean()`  
Then all cached tiles should be removed from IndexedDB  
And `map.stats()` should show zero tiles cached
