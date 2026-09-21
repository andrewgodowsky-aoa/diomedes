import { expect, type Page } from '@playwright/test';

/**
 * A launch opens to Diomedes, for a returning person too. The project they last had open is one
 * click away in the open-projects bar, and its last tab is the project the app used to reopen by
 * itself. A spec that works inside a project picks it up here after its first `page.goto`.
 *
 * A reload is not a launch: the window keeps its place, so nothing calls this after
 * `page.reload()`.
 */
export async function reopenLastProject(page: Page) {
  const tab = page
    .getByRole('navigation', { name: 'Open projects', exact: true })
    .locator('.project-tab:has(.project-tab-name)')
    .last();
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(tab).toHaveClass(/active/);
}
