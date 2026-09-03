/**
 * @typedef {object} ButtonProps
 * @property {string} [label]
 * @property {'primary' | 'danger'} [variant]
 * @property {boolean} [disabled]
 */

/**
 * @typedef {object} ButtonInstance
 * @property {HTMLButtonElement} root
 * @property {(props: Partial<ButtonProps>) => void} update
 */

/** @type {Record<string, string>} */
const VARIANT_CLASSES = {
  primary: 'cvy-button',
  danger: 'cvy-button cvy-button--danger',
}

/**
 * A tiny vanilla "component": a factory that returns `{ root, update }`.
 * `update` re-renders in place (reconciliation) so `component.update(props)`
 * in a test preserves the element — and anything listening to it.
 *
 * @param {ButtonProps} [props]
 * @returns {ButtonInstance}
 */
export function Button(props = {}) {
  const state = {
    label: props.label ?? 'Button',
    variant: props.variant ?? 'primary',
    disabled: props.disabled ?? false,
  }
  const root = document.createElement('button')
  root.type = 'button'

  const render = () => {
    root.className = VARIANT_CLASSES[state.variant] ?? VARIANT_CLASSES.primary
    root.textContent = state.label
    root.disabled = state.disabled
  }

  render()

  return {
    root,
    update(next = {}) {
      if (next.label !== undefined) state.label = next.label
      if (next.variant !== undefined) state.variant = next.variant
      if (next.disabled !== undefined) state.disabled = next.disabled
      render()
    },
  }
}
