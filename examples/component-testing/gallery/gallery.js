// The gallery contract (https://playwright.dev/docs/test-components):
//
//   window.mount({ story, props }) -> Promise  renders a story into #root
//   window.unmount()              -> Promise  tears the story down
//
// - An unknown story id or a render error must reject, so the test's `mount()`
//   call fails with a real error message.
// - The #root container is reused across calls: when the same story is mounted
//   again with new props (what `component.update(props)` does under the hood),
//   the gallery reconciles via the story's `update` hook instead of remounting,
//   preserving component state.
import { stories } from './registry.js'

/**
 * @typedef {object} MountedStory
 * @property {string} id
 * @property {{ root: HTMLElement, update?: (props: Record<string, unknown>) => void }} instance
 */

/** @type {MountedStory | null} */
let current = null

/** @param {string} storyId @returns {string} */
function resolveStory(storyId) {
  if (Object.prototype.hasOwnProperty.call(stories, storyId)) return storyId
  // Convenience: any unique path suffix works, e.g. 'Button/Primary'.
  const matches = Object.keys(stories).filter((id) => id === `/${storyId}` || id.endsWith(`/${storyId}`))
  if (matches.length === 1) return matches[0]
  const known = Object.keys(stories)
    .map((id) => `  - ${id}`)
    .join('\n')
  throw new Error(`Unknown story "${storyId}". Known stories:\n${known}`)
}

function clearRoot() {
  document.getElementById('root').replaceChildren()
}

/**
 * @param {{ story: string, props?: Record<string, unknown> }} params
 * @returns {Promise<void>}
 */
function mountStory({ story, props }) {
  const id = resolveStory(story)
  const nextProps = props ?? {}

  if (current !== null && current.id === id && current.instance.update !== undefined) {
    current.instance.update(nextProps)
    return Promise.resolve()
  }

  clearRoot()
  const instance = stories[id](nextProps)
  document.getElementById('root').append(instance.root)
  current = { id, instance }
  return Promise.resolve()
}

/** @returns {Promise<void>} */
function unmountStory() {
  clearRoot()
  current = null
  return Promise.resolve()
}

window.mount = mountStory
window.unmount = unmountStory
