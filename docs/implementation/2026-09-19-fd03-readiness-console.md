# FD03 Console readiness presentation

The Console adds a Readiness view over the existing read-only `/api/readiness` projection. It keeps implemented, installed, authorized, verified and healthy-now results separate and uses ordinary Yes, No and Unknown labels. Workflow cards name only their chosen requirements and show plain blocker text. Source and freshness details stay available behind an expandable disclosure.

Opening the view and selecting **Refresh status** perform GET requests only. The optional project checkbox adds the current project id so the server may include its saved connection observations. Its label and nearby copy say that refresh does not probe tools, sign in or change authority.

The page aborts an older request and checks a monotonic request epoch before publishing a response. Project changes, scope changes and repeated refreshes therefore cannot let an older response overwrite the current project. The layout uses flexible, wrapping grids and collapses the five axes at narrower Console widths.

`tests/fd03-readiness.spec.ts` covers unknown verification and workflow blockers, exact GET-only refresh behavior, project switching with a delayed stale response, optional project scope, expandable evidence and 1024 px horizontal containment. The browser test is registered in `playwright.config.ts`; execution remains with the integration owner holding the shared browser slot.
