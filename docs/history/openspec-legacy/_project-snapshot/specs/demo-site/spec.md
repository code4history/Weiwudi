# demo-site Specification

## Purpose
TBD - created by archiving change test-demo-creation. Update Purpose after archive.
## Requirements
### Requirement: Demo Page Accessibility
The project MUST provide a demo page accessible at the root URL when running the dev server.

#### Scenario: Dev Server Access
Given I have started the dev server with `pnpm dev`  
When I navigate to `http://localhost:5173/`  
Then I should see a Leaflet map  
And the page should load without errors

### Requirement: Map Tile Display
The demo page MUST display a functional map with tile layers that can be panned and zoomed.

#### Scenario: Map Interaction
Given the demo page is loaded  
When I pan or zoom the map  
Then new map tiles should load  
And tiles should be served via the Weiwudi Service Worker

### Requirement: Cache Statistics Display
The demo page MUST display real-time cache statistics showing the number of cached tiles and total cache size.

#### Scenario: Statistics Panel
Given the demo page is loaded  
When tiles are cached  
Then the statistics panel should update automatically  
And it should show the tile count  
And it should show the cache size in human-readable format (bytes/KB/MB)

#### Scenario: Statistics Polling
Given the Service Worker is caching tiles  
When the cache state changes  
Then the statistics panel should refresh within 2 seconds  
And the displayed values should match `map.stats()` results

### Requirement: Cache Clear Control
The demo page MUST provide a button to clear all cached tiles.

#### Scenario: Clear Cache Button
Given tiles are cached  
When I click the "Clear Cache" button  
Then all tiles should be removed from cache  
And the statistics panel should update to show zero tiles  
And a confirmation message should be displayed

### Requirement: Service Worker Integration
The demo page MUST properly register and communicate with the Weiwudi Service Worker.

#### Scenario: SW Registration on Load
Given I load the demo page  
When the page initializes  
Then the Weiwudi Service Worker should register  
And the SW should activate before map tiles load  
And any registration errors should be displayed to the user

