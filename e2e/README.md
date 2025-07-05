# E2E Tests for Weiwudi

This directory contains end-to-end tests for Weiwudi using Playwright.

## Running Tests

```bash
# Run all E2E tests
pnpm run test:e2e

# Run in UI mode for debugging
pnpm run test:e2e:ui

# Run in CI mode (Chromium only)
pnpm run test:e2e:ci
```

## Test Strategy

E2E tests focus on:
1. Service Worker registration and activation
2. Cache operations (register, fetch, clean)
3. MVT (Mapbox Vector Tile) support
4. Quota management
5. Plugin system integration

## Installing Playwright

```bash
# Install browsers
pnpm exec playwright install

# Or install only Chromium for CI
pnpm exec playwright install chromium
```