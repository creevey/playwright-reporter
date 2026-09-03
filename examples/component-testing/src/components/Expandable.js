/**
 * @typedef {object} ExpandableProps
 * @property {string} [title]
 * @property {boolean} [expanded]
 */

/**
 * @typedef {object} ExpandableInstance
 * @property {HTMLElement} root
 * @property {(props: Partial<ExpandableProps>) => void} update
 * @property {(listener: (expanded: boolean) => void) => void} onToggle
 */

/**
 * Stateful component: `expanded` lives inside the component and survives
 * `update(props)` (reconciliation), the same way framework state survives a
 * re-render.
 *
 * @param {ExpandableProps} [props]
 * @returns {ExpandableInstance}
 */
export function Expandable(props = {}) {
  const state = {
    title: props.title ?? 'Details',
    expanded: props.expanded ?? false,
  }
  /** @type {((expanded: boolean) => void) | null} */
  let onToggle = null

  const root = document.createElement('div')
  root.className = 'cvy-expandable'

  const header = document.createElement('button')
  header.type = 'button'
  header.className = 'cvy-expandable__header'

  const body = document.createElement('div')
  body.className = 'cvy-expandable__body'
  body.textContent = 'These settings only appear while the component is expanded.'

  const render = () => {
    header.textContent = `${state.title} ${state.expanded ? '▾' : '▸'}`
    header.setAttribute('aria-expanded', String(state.expanded))
    body.hidden = !state.expanded
  }

  header.addEventListener('click', () => {
    state.expanded = !state.expanded
    render()
    onToggle?.(state.expanded)
  })

  root.append(header, body)
  render()

  return {
    root,
    update(next = {}) {
      if (next.title !== undefined) state.title = next.title
      render()
    },
    onToggle(listener) {
      onToggle = listener
    },
  }
}
