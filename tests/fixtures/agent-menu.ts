import { expect, type Page } from '@playwright/test';

/**
 * The ask row's Agent menu (DIO-292), by the name a person hears. The Agent box replaced the mode
 * strip: a spec that clicked Ask, Plan, Build or Fix picks Researcher, Planner, Builder or Fixer
 * here. A new thread starts on Auto.
 */
export const AGENT_MENU = 'Agent for this thread';

/** Picks an Agent for the open thread, and waits until the box names it. */
export async function chooseAgent(page: Page, name: string) {
  const box = page.getByRole('button', { name: AGENT_MENU });
  await box.click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${name}\\b`) }).click();
  await expect(box.locator('.mdl')).toHaveText(name);
}
