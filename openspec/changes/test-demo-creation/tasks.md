# Implementation Tasks

## Phase 1: E2E Test Infrastructure
- [x] Install Playwright and configure for E2E testing
- [x] Create test fixtures (minimal Service Worker, test HTML page)
- [x] Write test: Service Worker registration and activation
- [x] Write test: Tile URL caching behavior
- [x] Write test: Cache statistics retrieval  
- [x] Write test: Cache clearing functionality
- [x] Add `test:e2e` script to package.json
- [x] Verify all tests pass locally

## Phase 2: Demo Site Implementation
- [x] Create `index.html` with Leaflet integration
- [x] Implement map initialization with tile layer
- [x] Register Weiwudi Service Worker from demo page
- [x] Create UI components:
  - [x] Cache statistics display panel
  - [x] Cache clear button
  - [x] Status messages/notifications
- [x] Wire up cache statistics polling
- [x] Implement cache clear button handler
- [x] Style demo page for professional appearance
- [x] Test demo locally with `pnpm dev`

## Phase 3: Integration & Documentation
- [x] Update README.md with demo instructions
- [x] Add testing section to README.md
- [x] Verify dev server serves demo at `http://localhost:5173/`
- [x] Run full test suite
- [x] Create demo screenshots for documentation (if needed)

## Validation

Each task should be verified by:
- **Tests**: Run via `pnpm run test:e2e` with all passing
- **Demo**: Manually verify at `http://localhost:5173/` showing map with working cache controls
