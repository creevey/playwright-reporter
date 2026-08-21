import { expect, test } from '@playwright/test'

test('hero visual', async ({ page }) => {
  await page.setContent('<h1 style="font-family: sans-serif">hello docker v3</h1>')
  await expect(page).toHaveScreenshot('hero.png')
})
