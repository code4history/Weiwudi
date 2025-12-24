# CI/CD Ready - Design

## Architecture Overview

This change introduces automated CI/CD pipelines using GitHub Actions. The design separates concerns into two distinct workflows:

1. **CI Workflow** (`ci.yml`) - Quality assurance for all branches
2. **Deploy Workflow** (`deploy.yml`) - Production deployment for master only

## Demo Build Strategy

### Current State
- Dev server (`pnpm dev`) serves `index.html` from project root
- Libraries built to `dist/` directory
- No separate demo build artifact

### Proposed Solution
Create a new Vite configuration (`vite.config.demo.js`) that:
- Takes `index.html` as entry point
- Bundles demo-specific code
- Copies built libraries from `dist/` into output
- Outputs complete standalone site to `dist-demo/`

### Build Script Dependency
```
pnpm run build       →  dist/weiwudi*.js (libraries)
pnpm run build:demo  →  dist-demo/ (complete demo site, includes libraries)
```

The `build:demo` script MUST run `build` first to ensure fresh library builds.

## GitHub Actions Workflows

### CI Workflow Design

**Triggers:** Push to any branch

**Job Matrix:**
- Node versions: [20.x, 22.x]
- Single OS: ubuntu-latest (sufficient for Node.js libraries)

**Steps:**
1. Checkout code
2. Setup pnpm (version 9)
3. Setup Node.js (matrix version)
4. Install dependencies (`pnpm install --frozen-lockfile`)
5. Run lint (`pnpm run lint`)
6. Run typecheck (`pnpm run typecheck`)
7. Run build (`pnpm run build`)
8. Run demo build (`pnpm run build:demo`)
9. Install Playwright browsers
10. Run E2E tests (`pnpm test`)

**Caching Strategy:**
- Cache pnpm store to speed up installs
- Cache Playwright browsers to avoid re-downloads

### Deploy Workflow Design

**Triggers:** Push to `master` branch only

**Permissions Required:**
- `contents: read` - Read repository
- `pages: write` - Deploy to Pages
- `id-token: write` - OIDC token for deployment

**Steps:**
1. Checkout code
2. Setup pnpm (version 9)
3. Setup Node.js (22.x, latest LTS)
4. Install dependencies
5. Run `pnpm run build` (libraries)
6. Run `pnpm run build:demo` (demo site)
7. Upload `dist-demo/` as Pages artifact
8. Deploy to GitHub Pages

**Deployment Environment:**
- Name: `github-pages`
- URL: Auto-configured by GitHub

## pnpm Configuration

Both workflows use `pnpm/action-setup@v2` with:
```yaml
with:
  version: 9
```

This ensures consistent package manager version across CI and local development (enforced by `engines` field in package.json).

## Alternative Approaches Considered

### Alternative 1: Single Workflow
Combine CI and deployment into one workflow with conditional steps.

**Rejected because:**
- Less clear separation of concerns
- Harder to maintain
- CI runs unnecessarily delay deployments

### Alternative 2: Separate Demo Repository
Create a separate repository for the demo site.

**Rejected because:**
- Increases maintenance burden
- Splits related code
- Complicates version sync

### Alternative 3: Manual Deployment
Keep manual deployment process.

**Rejected because:**
- Error-prone
- No deployment history
- Slower iteration

## Dependencies on Other Changes

- ✅ Requires E2E test suite (completed in `test-demo-creation`)
- ✅ Requires demo site (index.html exists)
- ✅ Requires build scripts (pnpm build works)
- ✅ Requires pnpm@9 enforcement (completed)
- ✅ Requires TypeScript migration (completed)

## Security Considerations

### GitHub Actions Permissions
- Workflows use least-privilege permissions
- `GITHUB_TOKEN` limited to required scopes
- OIDC for Pages deployment (more secure than deploy keys)

### Dependency Security
- `pnpm install --frozen-lockfile` prevents supply chain attacks
- Dependabot can be enabled for automated dependency updates (future)

## Rollback Strategy

If deployment fails or causes issues:
1. Revert commit on master
2. Push revert to trigger re-deployment
3. GitHub Pages will deploy previous working version

For rollback to specific version:
1. `git revert` or `git reset` to target commit
2. Force push to master (requires admin)
3. Deployment workflow re-runs automatically

## Testing Strategy

### Local Testing
- Test `build:demo` locally before pushing
- Serve `dist-demo` with `python -m http.server` to verify

### CI Testing
- Push to feature branch first
- Verify CI workflow completes successfully
- Check build artifacts in workflow logs

### Deployment Testing
- Merge to master
- Monitor deployment workflow
- Verify site at GitHub Pages URL
- Run manual smoke tests on deployed demo
