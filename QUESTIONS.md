# Questions (Book threads, muse/book-threads)

1. The Ask page's "New thread" button posts to `/threads` with no body, so the
   new thread is always a project thread, even when a document is attached in
   the composer.
   - Options: (a) keep project thread; (b) pass the attached document as
     `attachedTo` so the thread belongs to that document.
   - Pick: (a), as specced. Say the word if it should be (b).
