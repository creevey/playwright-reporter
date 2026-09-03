import { test, expect } from '@playwright/test'

// Interaction + state recording + visual regression in one test:
// the story records its internal `expanded` state into a hidden input, the
// test flips it with a real click, asserts the recorded value, and then
// screenshots the whole story root (the returned locator) to capture the
// expanded rendering.
test('records expanded state and matches the expanded baseline', async ({ mount }) => {
  const component = await mount('components/Expandable/Stateful')

  await expect(component.getByTestId('expanded')).toHaveValue('false')

  await component.getByRole('button', { name: 'Advanced settings' }).click()
  await expect(component.getByTestId('expanded')).toHaveValue('true')

  await expect(component).toHaveScreenshot('expanded.png')
})

// update() reconciles instead of remounting: the title re-renders, the
// expanded state recorded in the story survives.
test('update preserves component state', async ({ mount }) => {
  const component = await mount('components/Expandable/Stateful')

  await component.getByRole('button', { name: 'Advanced settings' }).click()
  await expect(component.getByTestId('expanded')).toHaveValue('true')

  await component.update({ title: 'Advanced settings (v2)' })
  await expect(component.getByRole('button', { name: 'Advanced settings (v2)' })).toBeVisible()
  await expect(component.getByTestId('expanded')).toHaveValue('true')
})
