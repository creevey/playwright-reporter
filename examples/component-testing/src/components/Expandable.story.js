// The "record state for assertions" pattern from
// https://playwright.dev/docs/test-components: the story owns the state and
// callbacks, and records the observable outcome into a hidden input next to
// the component. The test clicks the header like a user and asserts the
// recorded value with a retrying, web-first assertion — no callback
// marshalling between Node and the browser.
import { Expandable } from './Expandable.js'

export const Stateful = () => {
  const component = Expandable({ title: 'Advanced settings', expanded: false })

  const recorder = document.createElement('form')
  recorder.hidden = true
  const input = document.createElement('input')
  input.dataset.testid = 'expanded'
  input.readOnly = true
  input.value = 'false'
  recorder.append(input)

  component.onToggle((expanded) => {
    input.value = String(expanded)
  })

  const root = document.createElement('div')
  root.append(component.root, recorder)

  return {
    root,
    update: (props = {}) => {
      component.update(props)
    },
  }
}
