/**
 * Files a browser runs code from when they are opened: an SVG, a web page and
 * an XML document. A model's proposal that writes one always waits for the
 * person's exact review, and no task grant covers it. The person's own writes
 * through the editor and Save to Files are theirs, and are not checked. `.htm`
 * and `.xhtml` cannot be proposed today; they are listed so that widening the
 * text extensions later cannot quietly let a grant cover them.
 *
 * Shared so that the Console offers a grant only where the server would honour
 * one: server/trust/scope-grants.ts refuses a grant for these files, and
 * client/console/Need.tsx does not offer one.
 */
export const exactReviewOnly = (name: string): boolean => /\.(svg|html?|xhtml|xml)$/i.test(name);
