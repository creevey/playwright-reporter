<script lang="ts">
  import { isDefined, type CrvyRprtrSuite, type CrvyRprtrTest, type TestStatus } from '../../types';
  import { countTestsStatus, filterTests, hasScreenshots, parseFilterString, type CrvyRprtrViewFilter } from '../helpers';
  import { cn, statusDotClass } from '../cn';
  import TreeItem from './TreeItem.svelte';

  interface Props {
    tests: CrvyRprtrSuite;
    selectedId?: string;
    focusedPath: string[] | null;
    isReport: boolean;
    isRunning: boolean;
    isUpdateMode: boolean;
    approvalEnabled: boolean;
    approvalMessage?: string;
    runEnabled: boolean;
    runMessage?: string | null;
    filter: CrvyRprtrViewFilter;
    canApprove: boolean;
    onFilterChange: (filter: CrvyRprtrViewFilter) => void;
    onSelect: (test: CrvyRprtrTest) => void;
    onOpen: (path: string[], opened: boolean) => void;
    onToggle: (path: string[], checked: boolean) => void;
    onStart: () => void;
    onStop: () => void;
    onUpdate: () => void;
    onRun: (item: CrvyRprtrSuite | CrvyRprtrTest) => void;
    onApprove: () => void;
    onNext: () => void;
    onApproveAll: () => void;
    runMode?: 'local' | 'docker';
    isPreparing?: boolean;
  }

  let {
    tests, selectedId, focusedPath, isReport, isRunning, isUpdateMode, approvalEnabled, approvalMessage, runEnabled, runMessage, filter, canApprove,
    onFilterChange, onSelect, onOpen, onToggle, onStart, onStop, onUpdate, onRun, onApprove, onNext, onApproveAll,
    runMode, isPreparing,
  }: Props = $props();

  let filterInput = $state('');
  let isAlt = $state(false);

  let status = $derived(countTestsStatus(tests));
  let filteredTests = $derived(filterTests(tests, filter));
  let visibleChildren = $derived(
    Object.values(filteredTests.children)
      .filter(isDefined)
      .filter((c) => hasScreenshots(c as CrvyRprtrSuite | CrvyRprtrTest))
  );

  function handleFilterInput(e: Event): void {
    const value = (e.target as HTMLInputElement).value;
    filterInput = value;
    onFilterChange(parseFilterString(value));
  }

  function handleClickByStatus(s: TestStatus): void {
    if (s === filter.status) {
      filterInput = filter.subStrings.join(' ');
      onFilterChange({ status: null, subStrings: filter.subStrings });
    } else {
      const sub = filter.subStrings.join(' ');
      filterInput = sub ? `${sub} status:${s}` : `status:${s}`;
      onFilterChange({ status: s, subStrings: filter.subStrings });
    }
  }

  $effect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code === 'AltLeft') { e.preventDefault(); isAlt = true; }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'AltLeft') { e.preventDefault(); isAlt = false; }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    return (): void => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
    };
  });
</script>

<div class="w-[300px] min-w-[300px] max-md:w-full max-md:min-w-0 max-md:max-h-[40vh] max-md:border-b max-md:border-r-0 bg-surface-alt border-r border-edge flex flex-col overflow-hidden">
  <!-- Header -->
  <div class="p-4 border-b border-edge bg-surface-alt shrink-0">
    <div class="flex justify-between items-start">
      <div>
        <h1 class="m-0 mb-2 text-base font-normal text-fg-bright">Crvy Rprtr</h1>
        {#if runEnabled && runMode !== undefined}
          <div class="text-[10px] uppercase tracking-wide text-fg-muted mb-1">
            {runMode}
          </div>
        {/if}
        {#if isUpdateMode}
          <div class="text-xs mb-2 px-2 py-1 text-success bg-success/10 rounded-sm">
            Review and approve screenshots
          </div>
        {/if}
        <div class="flex gap-2 text-xs mb-3 tabular-nums">
          {#each [
            { key: 'success' as TestStatus, count: status.successCount },
            { key: 'failed' as TestStatus, count: status.failedCount },
            { key: 'pending' as TestStatus, count: status.pendingCount },
          ] as { key, count }}
            <button
              class={cn(
                'flex items-center gap-1 px-2 py-1 min-h-[28px] bg-transparent border border-transparent rounded-sm text-fg cursor-pointer text-xs transition-colors hover:border-edge focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
                filter.status === key && 'border-accent! bg-accent/15',
              )}
              onclick={() => handleClickByStatus(key)}
            >
              <span class={cn('size-2 rounded-full inline-block shrink-0', statusDotClass(key))}></span>
              <span>{count}</span>
            </button>
          {/each}
          {#if status.approvedCount > 0}
            <button
              class={cn(
                'flex items-center gap-1 px-2 py-1 min-h-[28px] bg-transparent border border-transparent rounded-sm text-fg cursor-pointer text-xs transition-colors hover:border-edge focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
                filter.status === 'approved' && 'border-accent! bg-accent/15',
              )}
              onclick={() => handleClickByStatus('approved')}
            >
              <span class="size-2 rounded-full inline-block shrink-0 bg-info"></span>
              <span>{status.approvedCount}</span>
            </button>
          {/if}
        </div>
      </div>
      {#if runEnabled}
        <div class="mt-1 flex gap-1">
          {#if isRunning}
            <button
              class="size-9 flex items-center justify-center bg-surface-input border border-edge rounded text-error cursor-pointer text-sm transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Stop tests"
              onclick={onStop}
            >&#9632;</button>
          {:else}
            <button
              class="size-9 flex items-center justify-center bg-surface-input border border-edge rounded text-success cursor-pointer text-sm transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Start tests"
              disabled={isPreparing === true}
              onclick={onStart}
            >&#9654;</button>
            <button
              class="size-9 flex items-center justify-center bg-surface-input border border-edge rounded text-success cursor-pointer text-sm transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Run and update baselines"
              title="Run & update baselines"
              disabled={isPreparing === true}
              onclick={onUpdate}
            >&#9654;&#8635;</button>
          {/if}
        </div>
      {/if}
    </div>
    <input
      type="text"
      class="w-full px-2.5 py-1.5 bg-surface-input border border-edge rounded text-fg text-ui outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors focus:border-accent placeholder:text-fg-muted"
      placeholder="Filter tests… (status:failed)"
      aria-label="Filter tests"
      autocomplete="off"
      value={filterInput}
      oninput={handleFilterInput}
    />
    {#if runMessage}
      <div class="mt-2 text-center text-xs text-fg-muted">{runMessage}</div>
    {/if}
  </div>

  <!-- Tree -->
  <div class="flex-1 overflow-y-auto overscroll-y-contain py-1" role="tree">
    {#each visibleChildren as child}
      <TreeItem
        item={child as CrvyRprtrSuite | CrvyRprtrTest}
        level={0}
        {selectedId}
        {focusedPath}
        {isUpdateMode}
        {runEnabled}
        {isRunning}
        {onSelect}
        {onOpen}
        {onToggle}
        {onRun}
      />
    {/each}
    {#if visibleChildren.length === 0}
      <div class="py-6 px-4 text-center text-fg-muted text-ui">No tests match filter</div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="py-3 px-4 border-t border-edge bg-surface-alt shrink-0">
    <div class="flex gap-2">
      {#if isAlt}
        <button
          class="flex-1 px-4 py-1.5 border border-edge rounded text-ui cursor-pointer transition-colors text-center bg-transparent text-fg hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent"
          disabled={!canApprove}
          onclick={onNext}
        >
          Next &#8250;
        </button>
      {:else}
        <button
          class="flex-1 px-4 py-1.5 border border-success rounded text-ui cursor-pointer transition-colors text-center bg-success text-white font-semibold hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent"
          disabled={!canApprove}
          onclick={onApprove}
        >
          Approve &#8250;
        </button>
      {/if}
      <button
        class="flex-1 px-4 py-1.5 border border-edge rounded text-ui cursor-pointer transition-colors text-center bg-transparent text-fg hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent"
        disabled={!approvalEnabled}
        onclick={() => { if (confirm('Approve all failed screenshots?')) onApproveAll(); }}
      >
        Approve All
      </button>
    </div>
    {#if !approvalEnabled && approvalMessage}
      <div class="mt-2 text-center text-xs text-fg-muted">{approvalMessage}</div>
    {/if}
  </div>
</div>
