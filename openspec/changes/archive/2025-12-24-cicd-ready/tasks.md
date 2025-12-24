# CI/CD Ready - Implementation Tasks

## Phase 1: Demo Build Configuration
- [x] Add `build:demo` script to package.json
- [x] Create Vite config for demo build (`vite.config.demo.js`)
- [x] Configure demo build to output to `dist-demo/`
- [x] Add `dist-demo/` to `.gitignore`
- [x] Test `pnpm run build:demo` locally

## Phase 2: CI Workflow
- [x] Create `.github/workflows/ci.yml`
- [x] Configure pnpm setup with version 9
- [x] Add Node 20 and 22 matrix strategy
- [x] Add lint step
- [x] Add typecheck step
- [x] Add build step (library)
- [x] Add build:demo step
- [x] Add test step (E2E with Playwright)
- [ ] Test workflow triggers on push to all branches

## Phase 3: Deployment Workflow
- [x] Create `.github/workflows/deploy.yml`
- [x] Configure pnpm setup with version 9
- [x] Add build:demo step
- [x] Configure GitHub Pages deployment action
- [x] Set workflow to trigger only on push to `master`
- [x] Add workflow permissions for Pages deployment

## Phase 4: Verification
- [ ] Push to feature branch, verify CI runs
- [ ] Merge to master, verify both CI and deployment run
- [ ] Check GitHub Pages site is accessible
- [ ] Verify demo site functions correctly
- [ ] Test E2E workflows pass in CI environment

## Phase 5: Documentation
- [x] Update README with CI/CD badge
- [x] Document deployment process
- [ ] Add troubleshooting guide for common CI issues
