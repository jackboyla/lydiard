# Linux Python environment repair

## Ongoing instructions

- Preserve project files and user work while repairing the local environment.
- Do not attempt to reuse a macOS virtual environment on Linux.

## Plan

1. Inspect the active shell and `.venv` interpreter metadata. Complete.
2. Identify the stale platform/path references. Complete.
3. Provide safe recreation and package-install commands. Complete.

## Decisions

- The existing `.venv` cannot be repaired in place: its Python target is a macOS ARM interpreter under `/Users/jackboylan`.
- Recreate `.venv` with the workstation's Linux Python.
- Treat `gitingets` as a typo for the package `gitingest`.
- No environment files were deleted automatically because the user only supplied the failure for diagnosis.

## Verification

- `.venv/bin/python` points to `/Users/jackboylan/.local/share/uv/python/cpython-3.10-macos-aarch64-none/bin/python3.10`.
- `.venv/bin/activate` exports `/Users/jackboylan/Desktop/lydiard/.venv`.
- Workstation `uv` is Linux x86_64 (`uv 0.11.28`).
- System Python is available at `/usr/bin/python3`.

## Outstanding

- User can recreate the environment and install `gitingest`; reinstall `garmin-health-data` too if the local Garmin workflow is needed.
