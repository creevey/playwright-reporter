// Maps story ids to story factories. The id convention is the story file path
// under src/ (without the `.story.*` extension) plus the exported name, e.g.
// `src/components/Button.story.js` exporting `Primary` becomes
// 'components/Button/Primary'.
//
// This file is the only bundler-specific piece. It uses plain static imports
// because the example has no bundler; with Vite you would generate the same
// map automatically:
//
//   const modules = import.meta.glob('../src/**/*.story.*', { eager: true })
import * as ButtonStories from '../src/components/Button.story.js'
import * as ExpandableStories from '../src/components/Expandable.story.js'

/** @type {Record<string, (props?: Record<string, unknown>) => { root: HTMLElement, update?: (props: Record<string, unknown>) => void }>} */
export const stories = {
  'components/Button/Primary': ButtonStories.Primary,
  'components/Button/Disabled': ButtonStories.Disabled,
  'components/Button/Danger': ButtonStories.Danger,
  'components/Button/WithTitle': ButtonStories.WithTitle,
  'components/Expandable/Stateful': ExpandableStories.Stateful,
}
