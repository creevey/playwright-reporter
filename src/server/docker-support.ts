import { spawn } from 'child_process'

import { detect } from 'package-manager-detector/detect'

export interface DockerExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type DockerExec = (args: string[]) => Promise<DockerExecResult>

export function createDockerExec(): DockerExec {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', reject)
      child.on('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        })
      })
    })
}

export async function probeDockerDaemon(exec: DockerExec): Promise<boolean> {
  try {
    const result = await exec(['info'])
    return result.exitCode === 0
  } catch {
    return false
  }
}

export async function isDockerImagePresent(exec: DockerExec, image: string): Promise<boolean> {
  try {
    const result = await exec(['image', 'inspect', image])
    return result.exitCode === 0
  } catch {
    return false
  }
}

export async function pullDockerImage(exec: DockerExec, image: string): Promise<boolean> {
  try {
    const result = await exec(['pull', image])
    return result.exitCode === 0
  } catch {
    return false
  }
}

export async function forceRemoveContainer(exec: DockerExec, name: string): Promise<void> {
  try {
    await exec(['rm', '-f', name])
  } catch {
    // Best-effort cleanup — the container may already be gone.
  }
}

export function resolveDockerImage(options: { image?: string; version: string | null }): string | null {
  if (options.image !== undefined && options.image !== '') return options.image
  if (options.version === null) return null
  return `mcr.microsoft.com/playwright:v${options.version}-noble`
}

/**
 * Container-side invokers per package manager, mirroring
 * `package-manager-detector`'s `execute-local` resolution. Only these four
 * agents are supported inside containers; anything else falls back to npx.
 * Module-private: consumed only by resolveContainerCommand.
 */
const CONTAINER_INVOKERS: Record<string, readonly string[]> = {
  npm: ['npx'],
  pnpm: ['pnpm', 'exec'],
  yarn: ['yarn'],
  bun: ['bunx'],
}

export const DEFAULT_CONTAINER_COMMAND: readonly string[] = ['npx']

export function resolveContainerCommand(input: {
  command?: string[]
  hasCustomImage: boolean
  detectedAgentName?: string | null
  warn?: (message: string) => void
}): string[] {
  if (input.command !== undefined && input.command.length > 0) return input.command
  // The default MS Playwright image only guarantees Node/npm.
  if (!input.hasCustomImage) return [...DEFAULT_CONTAINER_COMMAND]
  if (input.detectedAgentName === undefined || input.detectedAgentName === null) {
    input.warn?.('Could not detect a package manager for the custom docker image; falling back to npx.')
    return [...DEFAULT_CONTAINER_COMMAND]
  }
  const invoker = CONTAINER_INVOKERS[input.detectedAgentName]
  if (invoker === undefined) {
    input.warn?.(`Package manager "${input.detectedAgentName}" is not supported in docker mode; falling back to npx.`)
    return [...DEFAULT_CONTAINER_COMMAND]
  }
  return [...invoker]
}

export interface DetectedAgent {
  name: string
  agent: string
}

export type DetectAgent = (cwd: string) => Promise<DetectedAgent | null>

export const detectProjectAgent: DetectAgent = async (cwd) => {
  try {
    const result = await detect({ cwd, strategies: ['lockfile', 'packageManager-field'] })
    return result === null ? null : { name: result.name, agent: result.agent }
  } catch {
    return null
  }
}

/**
 * Maps an absolute path from the container's mount namespace back to the host.
 * Only exact matches and direct descendants of `mapping.from` are rewritten;
 * prefix lookalikes like `/workspace` are left untouched.
 */
export function rewriteContainerPath(path: string, mapping: { from: string; to: string }): string {
  if (path === mapping.from) return mapping.to
  if (path.startsWith(`${mapping.from}/`)) return mapping.to + path.slice(mapping.from.length)
  return path
}
