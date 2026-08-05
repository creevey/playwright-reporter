<script lang="ts">
  import { isBulkApprovalOptimisticSafe } from '../approval-api';
  import type { ApprovalResult, BulkApprovalResult } from '../approval-api';
  import type { CrvyRprtrSuite, CrvyRprtrTest, ImagesViewMode, TestStatus } from '../types';
  import { isTest, isDefined } from '../types';
  import {
    openSuite,
    checkSuite,
    getTestByPath,
    getTestPath,
    getFailedTests,
    getCheckedTests,
    setSearchParams,
    getTestPathFromSearch,
    filterTests,
    flattenSuite,
    getSuiteByPath,
    hasScreenshots,
    recalcSuiteStatuses,
    recalcAllSuiteStatuses,
    syncTreeState,
    collectTestsById,
    markTestsPending,
    type CrvyRprtrViewFilter,
  } from './helpers';
  import { captureTestStatuses, restoreTestStatuses } from './helpers/run-snapshot';
  import type { ClientWebSocketMessage, TestData } from '../types';
  import { WebSocketMessageSchema, safeParse } from '../schemas';
  import { getViewMode } from './viewMode';
  import Sidebar from './components/Sidebar.svelte';
  import ResultsPage from './components/ResultsPage.svelte';
  import Toggle from './components/Toggle.svelte';

  interface RunTestDescriptor {
    file: string;
    line: number;
    column?: number;
    projectName?: string;
    titlePath: string[];
  }

  interface RunFilters {
    tests?: RunTestDescriptor[];
    update?: boolean;
  }

  interface Props {
    initialTests: CrvyRprtrSuite;
    isReport: boolean;
    isUpdateMode: boolean;
    liveUpdates: boolean;
    approvalEnabled: boolean;
    approvalMessage?: string;
    runEnabled: boolean;
    isRunning: boolean;
    runMode?: 'local' | 'docker';
    onApprove: (id: string, retry: number, image: string) => Promise<ApprovalResult>;
    onApproveAll: () => Promise<BulkApprovalResult>;
  }

  let { initialTests, isReport, isUpdateMode, liveUpdates, approvalEnabled, approvalMessage, runEnabled, isRunning: initialIsRunning, runMode, onApprove, onApproveAll }: Props = $props();

  // svelte-ignore state_referenced_locally — intentionally capture initial value for local mutation
  let tests = $state(initialTests);
  // svelte-ignore state_referenced_locally — intentionally capture initial value for local mutation
  let isRunning = $state(initialIsRunning);
  let runMessage = $state<string | null>(null);
  let isPreparing = $state(false);
  let runSnapshot: Map<string, TestStatus | undefined> | null = null;
  let runEventIds: Set<string> = new Set();
  let openedTestPath = $state<string[]>([]);
  let filter = $state<CrvyRprtrViewFilter>({ status: null, subStrings: [] });
  let viewMode = $state<ImagesViewMode>(getViewMode());
  let focusedPath = $state<string[] | null>([]);
  let isDark = $state(localStorage.getItem('crvy-rprtr-theme') !== 'light');

  let openedTest = $derived(getTestByPath(tests, openedTestPath));
  let failedTests = $derived(getFailedTests(tests).filter(hasScreenshots));
  let retry = $state(0);
  let imageName = $state('');

  let testResult = $derived(openedTest?.results?.[retry - 1] ?? null);
  let currentImage = $derived(testResult?.images?.[imageName] ?? null);
  let canApprove = $derived(
    approvalEnabled && Boolean(
      openedTest?.results?.[retry - 1]?.images &&
      openedTest.approved?.[imageName] !== retry - 1 &&
      openedTest.results[retry - 1]?.status !== 'success',
    ),
  );

  let suiteList = $derived(flattenSuite(filterTests(tests, filter)));

  $effect(() => {
    if (openedTest) {
      const r = openedTest.results?.length ?? 0;
      retry = r;
      const result = openedTest.results?.[r - 1];
      imageName = result?.images ? Object.keys(result.images)[0] ?? '' : '';
    }
  });

  $effect(() => {
    if (openedTestPath.length > 0 && !openedTest) {
      openedTestPath = [];
    }
  });

  $effect(() => {
    localStorage.setItem('crvy-rprtr-theme', isDark ? 'dark' : 'light');
    document.documentElement.classList.toggle('light', !isDark);
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
  });

  $effect(() => {
    const handlePopState = (event: PopStateEvent): void => {
      const state = event.state as { testPath?: string[] } | null;
      if (state?.testPath && Array.isArray(state.testPath)) {
        openSuite(tests, state.testPath, true);
        openedTestPath = state.testPath;
      }
    };
    window.addEventListener('popstate', handlePopState);
    const testPath = getTestPathFromSearch();
    if (testPath.length > 0) {
      openSuite(tests, testPath, true);
      openedTestPath = testPath;
    }
    return (): void => window.removeEventListener('popstate', handlePopState);
  });

  $effect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (focusedPath === null) return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

      switch (e.code) {
        case 'ArrowDown': {
          e.preventDefault();
          const idx = focusedPath.length === 0 ? -1 : getFocusedIndex(focusedPath);
          if (idx < suiteList.length - 1) {
            const next = suiteList[idx + 1];
            const nextPath = isTest(next.suite) ? getTestPath(next.suite) : next.suite.path;
            focusedPath = nextPath;
          }
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const idx = focusedPath.length === 0 ? 0 : getFocusedIndex(focusedPath);
          if (idx > 0) {
            const prev = suiteList[idx - 1];
            const prevPath = isTest(prev.suite) ? getTestPath(prev.suite) : prev.suite.path;
            focusedPath = prevPath;
          } else {
            focusedPath = [];
          }
          break;
        }
        case 'ArrowRight': {
          if (focusedPath.length === 0) return;
          const focused = getSuiteByPath(tests, focusedPath);
          if (focused && !isTest(focused)) {
            openSuite(tests, focused.path, true);
          }
          break;
        }
        case 'ArrowLeft': {
          if (focusedPath.length === 0) return;
          const focused = getSuiteByPath(tests, focusedPath);
          if (!focused) return;
          if (!isTest(focused) && focused.opened) {
            openSuite(tests, focused.path, false);
          } else {
            const parentPath = isTest(focused) ? getTestPath(focused) : focused.path;
            focusedPath = parentPath.slice(0, -1);
          }
          break;
        }
        case 'Enter': {
          if (focusedPath.length === 0) return;
          const focused = getSuiteByPath(tests, focusedPath);
          if (!focused) return;
          if (isTest(focused) && focused.results?.length) {
            handleOpenTest(focused);
          } else if (!isTest(focused)) {
            openSuite(tests, focused.path, !focused.opened);
          }
          break;
        }
        case 'Space': {
          if (e.altKey) return;
          if (focusedPath.length === 0) return;
          e.preventDefault();
          const focused = getSuiteByPath(tests, focusedPath);
          if (!focused) return;
          const path = isTest(focused) ? getTestPath(focused) : focused.path;
          checkSuite(tests, path, !focused.checked);
          break;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return (): void => document.removeEventListener('keydown', handleKeyDown);
  });

  function getFocusedIndex(path: string[]): number {
    return suiteList.findIndex((x) => {
      const xPath = isTest(x.suite) ? getTestPath(x.suite) : x.suite.path;
      return path.length === xPath.length && path.every((p, i) => p === xPath[i]);
    });
  }

  function handleOpenTest(test: CrvyRprtrTest): void {
    const testPath = getTestPath(test);
    setSearchParams(testPath);
    focusedPath = testPath;
    openSuite(tests, testPath, true);
    openedTestPath = testPath;
  }

  function handleSuiteOpen(path: string[], opened: boolean): void {
    openSuite(tests, path, opened);
  }

  function handleSuiteToggle(path: string[], checked: boolean): void {
    checkSuite(tests, path, checked);
  }

  function handleGoToNextFailed(): void {
    if (failedTests.length === 0) return;
    const currentIndex = failedTests.findIndex((t) => t.id === openedTest?.id);
    const failedImages = Object.entries(testResult?.images ?? {})
      .filter(([name]) =>
        Boolean(
          testResult?.images?.[name]?.error !== null &&
          openedTest?.approved?.[name] !== retry - 1 &&
          testResult?.status !== 'success',
        ),
      )
      .map(([name]) => name);

    if (
      failedImages.length > 1 &&
      (failedTests.length === 1 || failedImages.indexOf(imageName) < failedImages.length - 1)
    ) {
      imageName = failedImages[failedImages.indexOf(imageName) + 1] ?? failedImages[0];
    } else {
      const nextFailed = failedTests[currentIndex + 1] ?? failedTests[0];
      handleOpenTest(nextFailed);
    }
  }

  async function handleImageApprove(): Promise<boolean> {
    if (!openedTest?.id || !canApprove) return false;
    const approvalResult = await onApprove(openedTest.id, retry - 1, imageName);
    if (!approvalResult.success) return false;
    if (!openedTest.approved) openedTest.approved = {};
    (openedTest.approved as Record<string, number>)[imageName] = retry - 1;
    const result = openedTest.results?.[retry - 1];
    if (result?.images) {
      const allApproved = Object.keys(result.images).every(
        (name) => openedTest!.approved?.[name] === retry - 1,
      );
      if (allApproved) {
        openedTest.status = 'approved';
        recalcSuiteStatuses(tests, getTestPath(openedTest));
      }
    }
    return true;
  }

  async function handleApproveAndGoNext(): Promise<void> {
    if (await handleImageApprove()) {
      handleGoToNextFailed();
    }
  }

  function getAllTests(suite: CrvyRprtrSuite): CrvyRprtrTest[] {
    return Object.values(suite.children)
      .filter(isDefined)
      .flatMap((child) => (isTest(child) ? [child] : getAllTests(child)));
  }

  async function handleApproveAllTests(): Promise<void> {
    const approvalResult = await onApproveAll();
    if (!isBulkApprovalOptimisticSafe(approvalResult)) return;
    getAllTests(tests).forEach((test) => {
      if (!test.results?.length) return;
      const lastIdx = test.results.length - 1;
      const lastResult = test.results[lastIdx];
      if (!lastResult?.images) return;
      test.approved = Object.fromEntries(
        Object.keys(lastResult.images).map((name) => [name, lastIdx]),
      );
      test.status = 'approved';
    });
    recalcAllSuiteStatuses(tests);
  }

  async function handleStart(filters?: RunFilters, target?: CrvyRprtrSuite | CrvyRprtrTest): Promise<void> {
    if (isRunning || runSnapshot !== null) {
      runMessage = 'A run is already in progress';
      return;
    }
    const markTarget = target ?? tests;
    runSnapshot = captureTestStatuses(markTarget);
    runEventIds = new Set();
    markTestsPending(markTarget);
    recalcAllSuiteStatuses(tests);
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filters ?? {}),
    });
    if (res.status === 409 || res.status === 400) {
      if (runSnapshot !== null) {
        restoreTestStatuses(tests, runSnapshot, runEventIds);
        recalcAllSuiteStatuses(tests);
        runSnapshot = null;
        runEventIds = new Set();
      }
      const body = (await res.json().catch(() => null)) as { reason?: string } | null;
      runMessage =
        body?.reason === 'already-running'
          ? 'A run is already in progress'
          : body?.reason === 'no-tests'
            ? 'No tests selected'
            : 'Connect a Playwright reporter to enable running';
    }
  }

  function finalizeRunSnapshot(): void {
    if (runSnapshot === null) return;
    restoreTestStatuses(tests, runSnapshot, runEventIds);
    recalcAllSuiteStatuses(tests);
    if (runEventIds.size === 0) {
      runMessage = 'Run produced no results — see the server terminal for details.';
    }
    runSnapshot = null;
    runEventIds = new Set();
  }

  function toDescriptor(test: CrvyRprtrTest): RunTestDescriptor | null {
    const { file, line, column } = test.location ?? {};
    if (file === undefined || line === undefined) return null;
    return {
      file,
      line,
      column,
      projectName: test.projectName,
      titlePath: [...(test.titlePath ?? []), test.title],
    };
  }

  function handleRunItem(item: CrvyRprtrSuite | CrvyRprtrTest): void {
    const descriptors = (isTest(item) ? [item] : getAllTests(item))
      .map(toDescriptor)
      .filter((d): d is RunTestDescriptor => d !== null);

    if (descriptors.length === 0) {
      runMessage = 'Cannot run: no source location for the selected test(s)';
      return;
    }
    handleStart({ tests: descriptors }, item);
  }

  async function handleStop(): Promise<void> {
    await fetch('/api/stop', { method: 'POST' });
  }

  async function handleUpdate(): Promise<void> {
    await handleStart({ update: true })
  }

  function handleImageChange(name: string): void {
    imageName = name;
  }

  function handleRetryChange(r: number): void {
    retry = r;
    const result = openedTest?.results?.[r - 1];
    if (result?.images) {
      const keys = Object.keys(result.images);
      if (!keys.includes(imageName)) {
        imageName = keys[0] ?? '';
      }
    }
  }

  function handleViewModeChange(mode: ImagesViewMode): void {
    viewMode = mode;
  }

  function handleThemeChange(dark: boolean): void {
    isDark = dark;
  }

  $effect(() => {
    if (!liveUpdates) {
      return;
    }

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${location.host}`);

    const handleMessage = (event: MessageEvent): void => {
      try {
        const raw: unknown = JSON.parse(event.data);
        const msg = safeParse(WebSocketMessageSchema, raw);
        if (msg === null) return;
        applyClientMessage(msg);
      } catch {
        // ignore parse errors
      }
    };

    const applyClientMessage = (msg: ClientWebSocketMessage): void => {
      switch (msg.type) {
        case 'test-begin':
        case 'test-update': {
          const current = collectTestsById(tests);
          current[msg.data.id] = msg.data;
          syncTreeState(tests, current);
          if (runSnapshot !== null) runEventIds.add(msg.data.id);
          break;
        }
        case 'run-end': {
          if (msg.data.removedTestIds.length === 0) break;
          const current = collectTestsById(tests);
          const next: Record<string, TestData> = {};
          const removed = new Set(msg.data.removedTestIds);
          for (const [id, data] of Object.entries(current)) {
            if (!removed.has(id)) next[id] = data;
          }
          syncTreeState(tests, next);
          break;
        }
        case 'sync': {
          syncTreeState(tests, msg.data.tests);
          break;
        }
        case 'approve':
          // No-op: approvals go through HTTP /api/approve.
          break;
        case 'run-status': {
          if (msg.data.phase === 'pulling') {
            isPreparing = true;
            runMessage = 'Pulling Docker image…';
            break;
          }
          isPreparing = false;
          if (msg.data.running) {
            isRunning = true;
            runMessage = null;
          } else {
            isRunning = false;
            finalizeRunSnapshot();
          }
          break;
        }
      }
    };

    ws.onmessage = handleMessage;

    return (): void => {
      ws.close();
    };
  });
</script>

<div class="flex h-dvh relative max-md:flex-col overflow-hidden">
  <Sidebar
    {tests}
    selectedId={openedTest?.id}
    {focusedPath}
    {isReport}
    {isRunning}
    {isUpdateMode}
    {approvalEnabled}
    {approvalMessage}
    {runEnabled}
    {runMessage}
    {filter}
    {canApprove}
    onFilterChange={(f) => filter = f}
    onSelect={handleOpenTest}
    onOpen={handleSuiteOpen}
    onToggle={handleSuiteToggle}
    onStart={handleStart}
    onUpdate={handleUpdate}
    {isPreparing}
    {runMode}
    onStop={handleStop}
    onRun={handleRunItem}
    onApprove={handleApproveAndGoNext}
    onNext={handleGoToNextFailed}
    onApproveAll={handleApproveAllTests}
  />
  <div class="flex-1 flex flex-col overflow-hidden min-w-0">
    {#if openedTest && testResult}
      <ResultsPage
        test={openedTest}
        {retry}
        {imageName}
        {viewMode}
        {canApprove}
        onImageChange={handleImageChange}
        onRetryChange={handleRetryChange}
        onViewModeChange={handleViewModeChange}
      />
    {:else}
      <div class="flex-1 flex items-center justify-center text-fg-muted text-base">
        Select a test to view results
      </div>
    {/if}
  </div>
  <div class="absolute top-3 right-3 max-md:top-1 max-md:right-1 z-10">
    <Toggle checked={isDark} onchange={handleThemeChange} />
  </div>
</div>
