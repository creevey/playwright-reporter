import { mount } from 'svelte'

import type { ApprovalResult, BulkApprovalResult } from './approval-api'
import { readApproveAllResult, readApproveResult } from './approval-api'
import App from './client/App.svelte'
import { treeifyTests } from './client/helpers'
import { ClientBootstrapDataSchema, ReportApiResponseSchema, safeParse } from './schemas'
import type { CrvyRprtrSuite } from './types'

interface InitialState {
  tests: CrvyRprtrSuite
  isReport: boolean
  isUpdateMode: boolean
  liveUpdates: boolean
  approvalEnabled: boolean
  approvalMessage?: string
  runEnabled: boolean
  isRunning: boolean
  runMode?: 'local' | 'docker'
}

function loadBootstrapData(): InitialState | null {
  const bootstrapElement = document.getElementById('crvy-rprtr-bootstrap')
  if (!(bootstrapElement instanceof HTMLScriptElement)) {
    return null
  }

  const json = bootstrapElement.textContent
  if (json === null || json.trim() === '') {
    return null
  }

  const raw: unknown = JSON.parse(json)
  const parsed = safeParse(ClientBootstrapDataSchema, raw)
  if (parsed === null) {
    throw new Error('Invalid embedded report bootstrap data')
  }

  return {
    tests: treeifyTests(parsed.report.tests),
    isReport: true,
    isUpdateMode: parsed.report.isUpdateMode,
    liveUpdates: parsed.liveUpdates,
    approvalEnabled: parsed.approvalEnabled,
    approvalMessage: parsed.approvalMessage,
    runEnabled: parsed.runEnabled ?? false,
    isRunning: parsed.report.isRunning ?? false,
  }
}

async function loadReportData(): Promise<InitialState> {
  const response = await fetch('/api/report')
  const data: unknown = await response.json()

  const parsed = safeParse(ReportApiResponseSchema, data)
  if (parsed === null) {
    throw new Error('Invalid API response format')
  }

  return {
    tests: treeifyTests(parsed.tests),
    isReport: true,
    isUpdateMode: parsed.isUpdateMode ?? false,
    liveUpdates: true,
    approvalEnabled: true,
    runEnabled: parsed.runEnabled ?? false,
    isRunning: parsed.isRunning ?? false,
    runMode: parsed.runMode,
  }
}

const handleApprove = async (id: string, retry: number, image: string): Promise<ApprovalResult> => {
  const response = await fetch('/api/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, retry, image }),
  })

  return readApproveResult(response)
}

const handleApproveAll = async (): Promise<BulkApprovalResult> => {
  const response = await fetch('/api/approve-all', { method: 'POST' })
  return readApproveAllResult(response)
}

const root = document.getElementById('root')!
root.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#808080;font-size:14px">Loading\u2026</div>`

const initialState = loadBootstrapData() ?? (await loadReportData())

root.innerHTML = ''
mount(App, {
  target: root,
  props: {
    initialTests: initialState.tests,
    isReport: initialState.isReport,
    isUpdateMode: initialState.isUpdateMode,
    liveUpdates: initialState.liveUpdates,
    approvalEnabled: initialState.approvalEnabled,
    approvalMessage: initialState.approvalMessage,
    runEnabled: initialState.runEnabled,
    isRunning: initialState.isRunning,
    runMode: initialState.runMode,
    onApprove: handleApprove,
    onApproveAll: handleApproveAll,
  },
})
