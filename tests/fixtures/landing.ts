import { expect, type Page } from '@playwright/test';

/**
 * A launch opens to Diomedes, for a returning person too. The project they last had open is one
 * click away in the open-projects bar, and its last tab is the project the app used to reopen by
 * itself. A spec that works inside a project picks it up here after its first `page.goto`.
 *
 * The bar's markup is drawn by whichever component owns the moment: the pre-entry strip
 * (`TopStrip`) before a project is picked, the Console's own header (`Shell`) once inside one, or
 * the retired Workbook's legacy header for that surface. Only the legacy header uses a
 * `.project-tab`/`active` class; the other two render plain buttons and mark the current project
 * with an `on` class instead. This matches on the accessible role, which all three share, and by
 * position rather than by name (a legacy tab can carry a status icon ahead of its name, which
 * would make the accessible name unstable across the click). It re-reads the nav after the click
 * since entering a project can swap it for a different component's copy of the same landmark, but
 * the last button stays the same project's in every one of the three layouts because clicking
 * never reorders the list.
 *
 * "Projects" is always the first button in the bar, so with nothing open besides it this would
 * silently click through to the Projects page instead of a project; that is treated as a fixture
 * error rather than let the spec fail later on a confusing symptom.
 *
 * A reload is not a launch: the window keeps its place, so nothing calls this after
 * `page.reload()`.
 */
export async function reopenLastProject(page: Page) {
  const openProjects = () => page.getByRole('navigation', { name: 'Open projects', exact: true });
  const buttons = openProjects().getByRole('button');
  await expect(buttons.first()).toBeVisible();
  const count = await buttons.count();
  if (count < 2) {
    throw new Error(
      'reopenLastProject: the Open projects bar has only the "Projects" button, so there is no ' +
        'project tab to click. Give the fixture at least one project in openProjects first.',
    );
  }
  await buttons.last().click();
  await expect(openProjects().getByRole('button').last()).toHaveClass(
    /(?:^|\s)(?:on|active)(?:\s|$)/,
  );
}
