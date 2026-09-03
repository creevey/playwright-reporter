import { test, expect } from '@playwright/test'

// Plain interaction test: `mount` navigates to the gallery and renders the
// story; everything else is an ordinary Playwright assertion.
test('renders a primary button', async ({ mount }) => {
  const component = await mount('components/Button/Primary')
  await expect(component.getByRole('button', { name: 'Submit' })).toBeVisible()
})

// Per-test props are plain serializable data passed straight to the story.
test('accepts per-test props and updates without remounting', async ({ mount }) => {
  const component = await mount('Button/WithTitle', { title: 'Hello' })
  const button = component.getByRole('button')

  await expect(button).toHaveText('Hello')

  // update() re-renders the same story with new props; the element handle
  // stays valid across the update.
  await component.update({ title: 'Hello again' })
  await expect(button).toHaveText('Hello again')
})

// Visual regression: screenshot the button element itself for a tight
// baseline. On the first run Playwright writes the baseline and fails; from
// then on any pixel change fails with expected/actual/diff attachments,
// which @crvy/rprtr shows in its UI for review and approval.
test('matches the primary baseline', async ({ mount }) => {
  const component = await mount('components/Button/Primary')
  await expect(component.getByRole('button')).toHaveScreenshot('primary.png')
})

test('matches the disabled baseline', async ({ mount }) => {
  const component = await mount('components/Button/Disabled')
  await expect(component.getByRole('button')).toHaveScreenshot('disabled.png')
})

test('matches the danger baseline', async ({ mount }) => {
  const component = await mount('components/Button/Danger')
  await expect(component.getByRole('button')).toHaveScreenshot('danger.png')
})
