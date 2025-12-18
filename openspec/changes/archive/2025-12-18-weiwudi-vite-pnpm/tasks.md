# Tasks: weiwudi-vite-pnpm

- [ ] **Preparation**
    - [ ] Clean up `node_modules` and `package-lock.json`.
    - [ ] Install `pnpm` (if not present in CI/env).

- [ ] **Package Management**
    - [ ] `pnpm install` dependencies.
    - [ ] Audit and fix vulnerabilities (`pnpm audit`).

- [ ] **Build System Migration**
    - [ ] Remove Webpack related dependencies (`webpack`, `babel-loader`, etc).
    - [ ] Install `vite` and `vite-plugin-pwa` (or `workbox-build`).
    - [ ] Create `vite.config.js`.
    - [ ] Update `package.json` scripts (`build`, `dev` etc).

- [ ] **Code Adjustments**
    - [ ] Move source files if necessary (e.g., `src/weiwudi.js` entry point).
    - [ ] Update import paths (if Vite requires specific resolution, usually fine for `.js`).
    - [ ] Ensure Service Worker logic works with new packaging.

- [ ] **Verification**
    - [ ] Run build.
    - [ ] Verify Service Worker registration and caching behavior.
    - [ ] Compare bundle size (old vs new).
