# Expert wisdom files

The coach reads two Markdown files from this directory and passes them to a connected agent as
background principles. See [../docs/agent-api.md](../docs/agent-api.md) for how they reach the API.

| File | Purpose |
| --- | --- |
| `scullion-principles.md` | Primary coaching reference |
| `magness-principles.md` | Secondary coaching reference |

Both filenames are gitignored. Whatever you write in them stays on your machine and in your own
deployment — it is never committed. The `.example.md` templates beside them are committed instead.

## Setup

`npm run wisdom:ensure` copies each template into place if the real file is missing. It runs
automatically before `dev`, `build`, and `worker:dev`, so a fresh clone builds without any manual
step. Edit the real files afterwards:

```bash
npm run wisdom:ensure
```

The files are imported at build time, so the Worker must be rebuilt after you change them:

```bash
npm run worker:deploy
```

## Writing them

Write durable principles rather than a fixed schedule. The coach reconciles this text with the
athlete's current physiology, recent response, injury constraints, and goal before proposing
anything, so absolute prescriptions age badly.

If you base a file on someone else's published coaching, write your own summary of the ideas and
credit the source. Do not paste transcripts or copyrighted text into these files — you would be
committing someone else's work to your own deployment.
