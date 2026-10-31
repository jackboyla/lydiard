## Agent Guidelines

- Always deploy when making UI changes; a fix/update is not considered complete until it has been deployed to production and verified.
- Commit and push to `main` every change you deploy, in the same session. Production must never run code that exists only in a working tree: the next agent deploys from a clean checkout and would silently remove it.
- Before deploying, check `git status`. If the working tree holds uncommitted changes you did not make, do not deploy around them from a clean copy. They may already be live. Ask the user how to handle them.
