# Design: Test and Demo Implementation

## Architecture Overview

This change introduces two independent but complementary systems:

1. **E2E Test Suite** - Automated Playwright tests running in headless browser
2. **Demo Site** - Interactive Leaflet map demonstrating Weiwudi capabilities

Both systems use the same Weiwudi library builds (UMD/ES) from `dist/`.

## E2E Testing Architecture

### Test Infrastructure
```
tests/
├── e2e/
│   ├── fixtures/
│   │   ├── test-sw.js        # Minimal SW using weiwudi-sw
│   │   └── test-page.html     # Test harness page
│   ├── cache.spec.js          # Cache operation tests
│   └── playwright.config.js   # Playwright configuration
```

### Test Strategy
- **Browser Context**: Each test runs in isolated Playwright context
- **Service Worker Lifecycle**: Tests verify SW registration, activation, and message passing
- **Cache Verification**: Tests don't require actual map rendering, just verify cache operations via API calls
- **Assertions**: Check cache statistics, verify IndexedDB entries (via SW messages)

### Key Trade-offs
- ✅ No need for full map rendering speeds up tests
- ✅ Isolated contexts prevent test interference
- ⚠️ Tests are browser-dependent (requires Playwright browsers)

## Demo Site Architecture

### Component Structure
```
index.html (root)
├── Leaflet.js (CDN)
├── dist/weiwudi.umd.js
├── demo-sw.js (Service Worker entry point)
└── Inline scripts:
    ├── Map initialization
    ├─ Cache statistics polling
    └── UI event handlers
```

### Data Flow
```
User Pan/Zoom 
  → Leaflet requests tiles
  → Weiwudi intercepts via SW
  → IndexedDB cache
  → Cache stats update
  → UI refresh
```

### UI Components
- **Map Container**: Full-width Leaflet map
- **Statistics Panel**: Floating div showing:
  - Cached tile count
  - Total cache size (bytes/KB/MB)
  - Last update timestamp
- **Control Buttons**:
  - Clear Cache
  - Fetch All Tiles (optional)

### Service Worker Strategy
- Demo uses same `weiwudi-sw` library as production 
- SW scope: `./` (entire site)
- Cache updates trigger message events to update UI

## Technology Choices

### Why Playwright?
- ✅ Real browser environment (Service Workers require it)
- ✅ Supports Service Worker testing
- ✅ Cross-browser testing capability
- ❌ Heavier than unit tests (acceptable trade-off)

### Why Leaflet?
- ✅ Popular, well-documented mapping library
- ✅ Simple integration (single script tag)
- ✅ Demonstrates real-world usage
- ❌ CDN dependency (acceptable for demo)

### Why Inline Scripts in Demo?
- ✅ Single-file demo easier to understand
- ✅ No build step for demo itself
- ✅ Works directly with `vite --host`
- ❌ Less maintainable for complex demos (acceptable - demo is intentionally simple)

## Development Workflow Impact

### Before
```bash
pnpm dev    # No demo, manual testing only
```

### After
```bash
pnpm dev           # Serves interactive demo at :5173
pnpm run test:e2e  # Runs Playwright tests
```

## Future Extensibility

- E2E tests can expand to cover:
  - Error handling scenarios
  - Concurrent cache operations
  - Storage quota limits
- Demo can add:
  - Multiple map layers
  - Cache export/import
  - Performance metrics
