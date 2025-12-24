# Test and Demo Site Creation

## Why

Weiwudi is a tile caching Service Worker library that needs comprehensive testing and demonstration capabilities. Currently, there are no automated tests to verify the core functionality (tile caching, cache statistics, cache clearing), and there is no demo site to showcase the library's capabilities to users and developers.

**Problems this solves:**
1. **Lack of automated testing**: No way to verify that cache operations work correctly across browser updates
2. **No visual demonstration**: Potential users cannot see the library in action without building their own implementation
3. **Manual verification burden**: Developers must manually test every change, which is time-consuming and error-prone

**User impact:**
- Developers can confidently use Weiwudi knowing it's well-tested
- New users can quickly understand the library's capabilities through an interactive demo
- Contributors can verify their changes don't break existing functionality

## What Changes

This change adds two major capabilities:

### 1. **E2E Testing with Playwright**
Automated browser-based tests that verify:
- Service Worker registration and activation
- Tile URL caching behavior
- Cache statistics retrieval
- Cache clearing functionality

### 2. **Interactive Demo Site**
A Leaflet-based map demonstration that shows:
- Real-time tile caching as users pan/zoom
- Live cache statistics (tile count, bytes used)
- Interactive cache clearing

## Dependencies

None - this change extends existing functionality without modifying core library code.

## Breaking Changes

None - this is purely additive (tests + demo).
