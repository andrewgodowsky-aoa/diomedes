// Harmless execution markers: no network, storage, or access to other files.
const script = '<script>document.title="markup-executed"</script>';
export const MARKUP_TEXT = [
  ['script', script],
  ['mixed-case HTML after ASCII whitespace', ` \t\r\n\v\f<!DoCtYpE hTmL>${script}`],
  ['comment before script', `<!-- ordinary-looking diagram notes -->${script}`],
  ['XML with executable XHTML', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>document.title="markup-executed"</script></html>`],
  ['BOM and whitespace', `\uFEFF \r\n<html>${script}</html>`],
  ['SVG after XML declaration', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="document.title=\'markup-executed\'"/>'],
  ['long whitespace prefix', `${' '.repeat(8192)}${script}`],
] as const;

export const PLAIN_TEXT = [
  ['notes.md', '# Notes\n\n<script>document.title="markup-executed"</script>\n'],
  ['example.markdown', '```html\n<script>document.title="markup-executed"</script>\n```\n'],
  ['flow.mmd', 'flowchart TD\n  A[Order] --> B[Ship]\n'],
  ['commented.MMD', '%% diagram notes\nflowchart TD\n  A --> B\n'],
] as const;
