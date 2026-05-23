# Review Handoff: Avoid login shells for POSIX direct shell execution

## Context

A code review found a P1 regression in `scripts/direct-shell.mjs`.

Affected code:
- `getPosixShellArgs(shellPath)`
- `getDirectShell(platform, env)`

Current behavior on Linux/macOS:
- `bash`, `zsh`, and `ksh` are launched with `-lc`
- This makes them login shells

## Problem

Using `-lc` causes POSIX shells to load user login startup files such as:
- `~/.bash_profile`
- `~/.zprofile`

This can make `custom_shell_execute` and `custom_run_tests` nondeterministic because local dotfiles may:
- print unexpected output
- set aliases/functions that change command behavior
- fail and break command execution entirely

This is a regression relative to the Windows path, which explicitly uses `-NoProfile`.

## Expected Fix

Update POSIX direct shell execution so commands are not launched as login shells.

Implementation intent:
- Do not use `-lc` for POSIX shells in `scripts/direct-shell.mjs`
- Use non-login execution arguments instead
- Preserve the existing ability to run arbitrary command strings through the selected shell
- Keep Windows behavior unchanged

Unless repo context shows a stronger reason otherwise, the expected POSIX argument is:
- `['-c']` for `bash`, `zsh`, `ksh`, and `/bin/sh`

## Required Code Review Checks

The implementing agent should verify all of the following:

1. `scripts/direct-shell.mjs` no longer launches POSIX shells as login shells.
2. `tests/shell-policy.test.mjs` is updated to reflect non-login POSIX arguments.
3. Any tests that rely on direct shell execution still pass.
4. No Windows behavior changes.
5. No new behavior is introduced around profile loading, shell selection, or command quoting.

## Repo Facts Already Verified

- `scripts/direct-shell.mjs` currently returns `['-lc']` for `bash`, `zsh`, and `ksh`, and `['-c']` otherwise.
- `tests/shell-policy.test.mjs` currently asserts `['-lc']` for `/bin/bash`.
- The regression affects tools exposed through the direct shell path, including `custom_shell_execute` and `custom_run_tests`.

## Suggested Validation

Run targeted tests at minimum:
- `node --test tests/shell-policy.test.mjs`
- `node --test tests/command-utils.test.mjs`
- `node --test tests/test-tool.test.mjs`

If broader shell-facing coverage is cheap, also run:
- `node --test tests/git-tools.test.mjs`
- `node --test tests/review-tools.test.mjs`
- `node --test tests/release-review.test.mjs`

## Non-Goals

- Do not refactor unrelated shell-policy logic.
- Do not change Windows PowerShell flags.
- Do not redesign shell selection unless needed to remove the login-shell regression.

## Review Reference

Original review finding:

> [P1] Avoid launching POSIX commands as login shells — `scripts/direct-shell.mjs:9-11`

Reason:
Running `bash`/`zsh`/`ksh` with `-lc` executes user profile scripts on Linux/macOS, which can pollute output or break commands depending on local dotfiles.
