# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-24

### Added

- **reporter:** Portable artifacts mode via CRVY_RPRTR_PORTABLE_ARTIFACTS
- **server:** --update-snapshots run flag and docker-unavailable run reason
- **server:** Carry run mode and phase in run-status broadcasts
- **server:** Docker CLI helpers and container command resolution
- **server:** DockerLauncher spawning playwright runs in containers
- **server:** Run-mode resolution, docker launcher wiring, and docker CLI flags
- **ui:** Run mode badge, update-baselines action, and image-pull state

### Changed

- **run-controller:** Extract RunLauncher strategy with LocalLauncher

### Documentation

- **spec:** Docker browser execution design
- **plan:** Docker browser execution implementation plan
- Docker mode usage and options
- Docker rendering determinism findings; correct baseline arch guidance

### Fixed

- **run-controller:** Make UI re-run work on Playwright 1.59+
- **server:** Surface auto-mode docker fallback warning
- **server:** Rewrite container paths in reporter register payloads
- **server:** Rewrite host paths in docker container command args
- **server:** Warn when --config path is unreachable inside container
- **reporter:** Content-addressed artifact names for static-host portability
- **server:** Route docker runs via rootDir-keyed --test-list with host paths

### Testing

- CI-gated docker smoke test for containerized runs
## [0.2.4] - 2026-07-06

### Added

- **cli:** Add --help/-h flag to print usage and exit 0
## [0.2.3] - 2026-07-03

### Fixed

- **server:** Persist report on interrupted runs and mid-run mutations
## [0.2.2] - 2026-07-03

### Miscellaneous

- Update repository URLs to creevey/rprtr
## [0.2.1] - 2026-07-03
## [0.2.0] - 2026-07-03

### Added

- **types:** Add run-status variant to ClientWebSocketMessage
- **reporter:** Include configFile and cwd in register message
- **server:** Add RunController for spawning playwright test
- **server:** Persist register payload configFile and cwd as runContext
- **server:** Instantiate RunController in createServerApp and dispose on close
- **server:** Add POST /api/run and /api/stop, surface runEnabled in /api/report
- **client:** Wire Start/Stop buttons to /api/run and /api/stop
- **client:** Add per-test and per-suite run buttons to sidebar tree
- **run-controller:** Resolve playwright via project package manager
- **run-controller:** Descriptor-based filter with positional translation
- **run-controller:** --test-list for suites with version fallback
- **client:** Descriptor filters, no-location feedback, isRunning guard
- **client:** Add captureTestStatuses/restoreTestStatuses helpers
- **client:** Revert orphaned pending on no-event run

### Changed

- **schemas:** Extract HTTP request schemas to schemas/http.ts
- **schemas:** Use discriminatedUnion for Run/Stop responses
- **run-controller:** Document cwd param and test launch fallback
- **reporter:** Make onBegin synchronous and defer screenshotDir creation
- **client:** Reset runEventIds on rejected-start path

### Documentation

- **spec:** Run tests from UI design
- **plan:** Run tests from UI implementation plan
- **spec:** Run-from-UI robustness design
- **plan:** Run-from-UI robustness implementation plan
- **spec:** Stuck-pending run recovery design
- **plan:** Stuck-pending run recovery implementation plan

### Fixed

- **run-controller:** Guard against duplicate exit/error cleanup
- **reporter:** Honor CRVY_RPRTR_SERVER_URL env as fallback serverUrl
- **run-controller:** Override reporters and strip CI env for UI-triggered runs
- **run-from-ui:** Row height, re-run status, filtered-run scope, startup config
- **run-from-ui:** Mark tests pending on start, use file:line:column for precise re-runs
- **run-controller:** Resolve @crvy/rprtr from project cwd then server module
- **run-controller:** Clean up test-list temp file on spawn throw
- **knip:** Enable production-mode analysis in strict checks

### Styling

- **client:** Match semicolon convention and destructure location
- **docs:** Reformat CLI options table

### Testing

- **client:** Cover undefined-restore and empty/bare-root edge cases
## [0.1.4] - 2026-06-19

### Added

- **path-utils:** Add cross-platform absolute path helpers
- **server:** Log diagnostic when /file URL cannot resolve on host OS

### Documentation

- **plans:** Cross-OS path handling and stale actual URL on passing rerun
- Document cross-OS artifact loading limitations

### Fixed

- **report-utils:** Route Windows-style absolute paths to /file on any host
- **server:** Check pre-resolve path for foreign-OS diagnostic
- **report-state:** Drop stale comparison actual URL on passed reruns
- **report-state:** Strip stale actual/diff when preserving baseline-only images

### Testing

- **path-utils:** Cover forward-slash UNC form
- **server-routes:** Cover baseline enrichment after failed→passed progression
## [0.1.3] - 2026-06-18

### Fixed

- **reporter:** Resolve browser label for Playwright's default project
## [0.1.2] - 2026-06-08

### Added

- Reporter sends register message with Playwright config to server
- Reporter sends register message with Playwright config to server

### Fixed

- **check:** Run publint after other checks to avoid race condition with build

### Styling

- Reformat long lines
- Reformat long lines
## [0.1.1] - 2026-06-08

### Fixed

- Preserve all tests when applying single WebSocket update
## [0.1.0] - 2026-06-08

### Added

- **resolver:** Expose playwrightAnonymousVisualName
- **resolver:** Add withResolvedVisualNames
- **server:** Add isPathWithinRoots allowlist helper
- **server:** Add allowlisted /file artifact route
- **server:** Add /baseline route, consolidate baseline resolution
- **server:** Wire artifactRoots and outputDir option
- Add isCI helper
- **report-utils:** Route absolute attachment paths to /file
- **server:** Enrich declared-only images with /baseline urls
- **reporter:** Add rewriteTestEndAttachments helper
- **reporter:** Gate screenshot copying and artifacts on CI
- **cli:** Add --output-dir for live native artifact serving

### Changed

- **resolver:** Compute anonymous title list once

### Documentation

- **spec:** CI-gated screenshot artifact handling design
- **plans:** Naming fix, live-mode serving, CI-gated copying
- **server:** Clarify outputDir is resolved against CWD

### Fixed

- Apply web socket payloads directly to the client tree
- **reporter:** Use Playwright auto-name for unnamed screenshots
- **server:** Realpath-guard /file route and set nosniff header
- **server:** Guard /baseline decode, retry parsing, and read errors
- **server:** Exclude test source dir from /file allowlist
- **server:** Guard /baseline url parsing, decode testId, test nosniff
- **server:** Decode /file URLs in approval path
- **server:** Only enrich declared-only baselines for passed tests
- **server:** Enrich baselines only when the snapshot file exists
- **reporter:** Bound onEnd concurrency, fix retry attachments, stop CI queue growth

### Styling

- **client:** Center-align image comparison views

### Testing

- **report-state:** Assert no phantom entry for finalized unnamed screenshot
- **report-state:** Make phantom-entry guard falsifiable
- Document phantom fixture divergence and cover multi-occurrence rewrite
- **server:** Cover raw-traversal and empty-roots cases for isPathWithinRoots
## [0.0.9] - 2026-06-05

### Fixed

- Remove file watcher that interfered with live updates
## [0.0.8] - 2026-06-05

### Fixed

- Broadcast test-begin events to UI and allow running→terminal status transitions
## [0.0.7] - 2026-06-05

### Ci

- Upgrade actions and node version for npm trusted publishing
## [0.0.6] - 2026-06-05

### Added

- Add named screenshot baseline resolver
- Resolve unnamed and duplicate screenshot baselines
- Resolve passed screenshot baselines through Playwright rules
- Persist approval resolver metadata in report state
- Emit approval resolver metadata from reporter
- Reuse resolver for approval routing
- Report mixed approval routing outcomes

### Changed

- Separate resolver attachment and artifact names
- Tighten screenshot declaration typing

### Documentation

- Add passed screenshot baseline resolution design
- Add passed screenshot baseline resolution plan
- Document passed screenshot baseline resolution options
- Narrow approval path claims
- Add template-aware approval routing design
- Add template-aware approval routing plan
- Align approval routing docs with resolver behavior
- Clarify approval routing configuration scope

### Fixed

- Sanitize named screenshot resolver inputs
- Preserve visual names in named baseline targets
- Disambiguate named screenshot baseline resolution
- Restore reporter declaration compatibility
- Use safe artifact names for copied baselines
- Encode copied baseline artifact paths safely
- Neutralize traversal segments in baseline artifact paths
- Encode saved attachment artifact paths safely
- Use stable traversal-safe artifact path encoding
- Preserve approval metadata through schemas
- Preserve visual name fallback for older payloads
- Use configured testDir for approval resolution
- Use configured configDir for approval resolution
- Require POST for approve-all routing
- Require POST for approve routing
- Report no-actual bulk approval outcomes
- Honor approval api results in client state

### Testing

- Cover exact approval routing cases

### Ci

- Switch npm publish to OIDC trusted publishing
## [0.0.5] - 2026-05-14

### Added

- Classify passed visual assertions in report state
- Emit declared visual names for screenshot steps
- Refresh report state from disk changes
- Label passed visual fallback states in ui

### Documentation

- Describe passed screenshot fallback modes

### Fixed

- **ci:** Checkout hooks submodule

### Miscellaneous

- Add you-lint-not-pass hook integration
- Exclude hooks repo from root checks
## [0.0.4] - 2026-04-23

### Added

- Add CJS build for reporter and server entry points
- Add require export conditions for CJS resolution

### Documentation

- Add publint integration design spec
- Add publint integration plan

### Fixed

- Add @playwright/test to knip ignoreDependencies

### Miscellaneous

- Remove local smoke-test project

### Testing

- Approve screenshot baselines for darwin and linux
- Add smoke test for CJS/ESM dual resolution

### Ci

- Run Playwright tests inside Playwright Docker container
- Add unzip for setup-bun in Playwright container
- Add publint as non-blocking check in check.sh

### Deps

- Add publint for package.json validation
- Add publint for package.json validation

### Pub

- Chain publint after build in prepublishOnly
## [0.0.3] - 2026-04-10

### Fixed

- Update repository URLs to match renamed GitHub repo
## [0.0.2] - 2026-04-10
## [0.0.1] - 2026-04-10

### Added

- Migrate UI from React to Svelte 5
- **reporter:** Implement offline mode for reporter
- **server:** Add offline report loading on startup
- Migrate React client to Svelte 5 with Tailwind CSS v4
- Improve server logging and add new view components
- Approve without page reload, update local state optimistically
- Rework slide view with per-side card frames and clip-path clipping
- Attach baseline screenshots for passing toHaveScreenshot tests
- Extract startServer function, add CLI entry point, fix static asset paths
- Build pipeline produces reporter, server, CLI, and type declarations
- Configure package.json for npm publishing
- Add live UI updates and Git LFS for screenshots
- Add packaged offline reporter UI

### Changed

- Consolidate into single package, fix Svelte build
- Remove CreeveyContext dependency, use local state for suite UI
- Replace Storybook naming with Playwright conventions
- Fix all lint errors, add zod schemas, modularize codebase
- Make CreeveySuite children optional and add helper functions
- Rename reporter to crvy rprtr
- Rename offline report files to shorter pattern

### Documentation

- Add offline mode documentation
- Rewrite README for package consumers

### Fixed

- Reporter WS queuing, treeify path, attachments→images mapping
- Type data field in OfflineEvent for type safety
- Address race condition and offline event persistence issues
- Correct assertion logic and rename misleading test
- Use fs/promises.writeFile instead of Bun.write in reporter
- Remove unused import and document offline mode limitations
- UI/UX polish — accessibility, responsive, visual design, build warning
- UI/UX polish — layout, accessibility, contrast, focus, counters
- Use CSS grid stacking in SwapView to fix image size mismatch
- Correct approve navigation, status update, baseline copy, and view fallback
- Update test selectors and refresh screenshot baselines
- Show successful screenshot tests in sidebar
- Show passing screenshot tests in report UI
- Remove stale tests on run-end and fix diff count log
- Remove incorrect baseline snapshot association and preserve images correctly
- Attach passing baseline as expected, not actual
- Reset approved flag when test fails with new diffs
- Show passing screenshot baselines after rerun
- Attach baselines for passing toHaveScreenshot tests via reporter
- Address publint and arethetypeswrong findings
- Use p-limit for concurrent file operations and fix eqeqeq errors
- Stabilize bun tests and offline fallback
- Resolve dist paths relative to test file in runtime-smoke tests
- Treat oxfmt exit code 2 as success in staged checks

### Miscellaneous

- Add MIT LICENSE
- Add advanced linting and code quality tools from papai
- Exclude CHANGELOG.md from oxfmt formatting

### Styling

- Format README, package.json, and tsconfig.build.json

### Testing

- Add offline mode tests
- Rewrite offline tests with meaningful behavior validation
- Add matrix CI integration test with worker-specific offline reports
- Remove offline report files test

### Ci

- Add GitHub Actions workflow for automated checks
## [Unreleased]
# test
