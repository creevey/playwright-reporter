// Stories wrap the component in one specific scenario: hard-coded props,
// mock data, state, callbacks. Each named export is one story; its id is
// derived from this file's path plus the export name ('components/Button/Primary').
import { Button } from './Button.js'

export const Primary = () => Button({ label: 'Submit' })

export const Disabled = () => Button({ label: 'Submit', disabled: true })

export const Danger = () => Button({ label: 'Delete', variant: 'danger' })

/**
 * Accepts per-test props: `mount('Button/WithTitle', { title: 'Hello' })`.
 * The story maps its own props onto the component's props, including on update.
 *
 * @param {{ title?: string }} [props]
 */
export const WithTitle = (props = {}) => {
  const button = Button({ label: props.title ?? 'Default' })
  /** @param {{ title?: string }} [next] */
  const update = (next = {}) => {
    button.update({ label: next.title })
  }
  return {
    root: button.root,
    update,
  }
}
