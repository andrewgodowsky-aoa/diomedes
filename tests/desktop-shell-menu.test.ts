import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The desktop shell helpers are an executable JavaScript module.
import { applicationMenuTemplate } from '../desktop/app-updates.mjs';

type MenuItem = { label?: string; role?: string; type?: string; click?: () => void };
type MenuSection = { label?: string; role?: string; submenu: MenuItem[] };

const EDIT_SUBMENU = [
  { role: 'undo' },
  { role: 'redo' },
  { type: 'separator' },
  { role: 'cut' },
  { role: 'copy' },
  { role: 'paste' },
  { role: 'selectAll' },
];
const VIEW_SUBMENU = [
  { label: 'Increase interface size', click: expect.any(Function) },
  { label: 'Decrease interface size', click: expect.any(Function) },
  { label: 'Reset interface size (100%)', click: expect.any(Function) },
  { type: 'separator' },
  { role: 'togglefullscreen' },
];

function build(platform: string) {
  const interfaceScale = vi.fn();
  const template = applicationMenuTemplate(platform, { interfaceScale }) as MenuSection[];
  return { interfaceScale, template };
}
function section(template: MenuSection[], label: string) {
  return template.find((entry) => entry.label === label || entry.role === label);
}
function expectInterfaceSizeHandlers(platform: string) {
  const { interfaceScale, template } = build(platform);
  const view = section(template, 'View');
  expect(view).toBeDefined();
  for (const item of view!.submenu) item.click?.();
  expect(interfaceScale.mock.calls).toEqual([['increase'], ['decrease'], ['reset']]);
}

describe('desktop shell application menu', () => {
  it('builds exactly the existing Windows menu', () => {
    const { template } = build('win32');
    expect(template).toEqual([
      { label: 'File', submenu: [{ role: 'quit' }] },
      { label: 'Edit', submenu: EDIT_SUBMENU },
      { label: 'View', submenu: VIEW_SUBMENU },
    ]);
  });

  it('keeps the Windows menu on Linux too', () => {
    const { template } = build('linux');
    expect(template.map((entry) => entry.label)).toEqual(['File', 'Edit', 'View']);
  });

  it('opens the darwin menu with the application menu', () => {
    const { template } = build('darwin');
    expect(template[0]).toEqual({
      label: 'Diomedes',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
    // A Quit-only File menu is a Windows convention; Quit lives in the app menu.
    expect(section(template, 'File')).toBeUndefined();
  });

  it('carries the edit and window role menus on darwin so Cmd shortcuts work', () => {
    const { template } = build('darwin');
    expect(section(template, 'Edit')).toEqual({ label: 'Edit', submenu: EDIT_SUBMENU });
    expect(section(template, 'window')).toEqual({
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    });
  });

  it('preserves every custom interface size item and its handler on both platforms', () => {
    const { template } = build('darwin');
    expect(section(template, 'View')).toEqual({ label: 'View', submenu: VIEW_SUBMENU });
    expectInterfaceSizeHandlers('win32');
    expectInterfaceSizeHandlers('darwin');
  });
});
