# CI/CD Ready

## Why

The project currently lacks automated testing and deployment infrastructure. This creates several risks:
- **Manual deployment errors**: No automated GitHub Pages deployment means human mistakes can happen
- **No quality gates**: Changes can be merged without verification (tests, linting, type-checking)
- **Inconsistent builds**: Demo site is manually managed instead of being built from source

Adding CI/CD automation will:
- Ensure every push is validated with tests, linting, and type-checking
- Automate GitHub Pages deployment for the demo site from master branch
- Provide confidence that changes don't break existing functionality
- Enable faster iteration with automated deployments

## What Changes

### New Build Script
- Add `build:demo` script to package.json that outputs demo site to `dist-demo/`
- Demo build includes index.html, built libraries, and all necessary assets
- Add `dist-demo/` to `.gitignore` (build artifact, not source)

### GitHub Actions Workflows
Two new workflow files in `.github/workflows/`:

1. **ci.yml** - Continuous Integration (all branches, all pushes)
   - Install dependencies with pnpm@9
   - Run linting (`pnpm run lint`)
   - Run type checking (`pnpm run typecheck`)  
   - Build library (`pnpm run build`)
   - Build demo (`pnpm run build:demo`)
   - Run E2E tests (`pnpm test`)
   - Test on Node 20 and 22

2. **deploy.yml** - GitHub Pages Deployment (master branch only)
   - Install dependencies with pnpm@9
   - Build demo site (`pnpm run build:demo`)
   - Deploy `dist-demo/` to GitHub Pages
   - Configure GitHub Pages to use GitHub Actions as source

### Repository Settings
- Enable GitHub Pages with GitHub Actions as source
- Branch protection for master (optional, recommended for future)

## Dependencies
- Requires completed E2E test suite (✅ done)
- Requires working demo site (✅ index.html exists)
- Requires working build scripts (✅ pnpm build works)

## Breaking Changes
None - this is purely additive infrastructure.

## Migration Path
1. Create and test workflows locally with `act` (optional)
2. Merge to master branch
3. Verify first deployment succeeds
4. Configure repository settings if needed
