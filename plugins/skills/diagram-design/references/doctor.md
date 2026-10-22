# Environment doctor

Load this file when the user asks to run diagnostics, health checks, or first-run troubleshooting.

The goal is a one-shot report that checks local readiness for Diagram Design import/export and command routing, without mutating user files or installing dependencies.

Resolve the Diagram Design installation from this loaded reference, not from the
user's current working directory. A normal project directory is the expected
place to invoke the doctor and must not be treated as a repository-path error.

Check the installed skill and its bundled helpers. Maintainer-only upstream repository files and other hosts' command routing are not required.

## Inputs

Optional flags:

- `--strict` — treat warnings as failures in the final summary.
- `--json` — print a machine-readable JSON report in addition to human summary.

If no flags are provided, run in standard mode.

## Required checks

Run all checks in this order and report each as `pass`, `warn`, or `fail`.

1. Python runtime
- Resolve the bundled Python interpreter first, then `python`. A name that is on PATH but cannot report
  its own version does not win the resolution: fall through to the next candidate.
  (Windows ships a `python3` App Execution Alias that is a Microsoft Store stub, not
  an interpreter, and it sits on PATH ahead of a python.org install.) A name that
  cannot be launched at all counts as the same kind of dud, and is reported as a
  failed check rather than ending the run.
- Require version >= 3.10.
- `fail` if no Python interpreter is found.
- `fail` if version is below 3.10.

2. Playwright availability for PNG export
- Check whether Playwright import works in the active Python interpreter (`import playwright`); an optional package version attribute is not required.
- Verify the already installed Microsoft Edge can launch through `playwright.chromium.launch(channel="msedge", headless=True)` in that interpreter and close it after the probe. Do not install or download a browser. Bound browser startup to 5 seconds and the subprocess probe to 10 seconds, then terminate the owned probe tree on timeout. Windows tree cleanup and parent reaping each have an additional 2-second limit; report cleanup failures as warnings.
- If missing, mark `warn` and report that the host environment must provision
  the optional Python Playwright package from an internal index or local wheels, and an existing Microsoft Edge installation.
- Never auto-install dependencies.

3. Expected helper presence
- Verify the installed `scripts/` contains `drawio_extract.py`, `mermaid_extract.py`, `excalidraw_extract.py`, `export_svg.py`, `export_png.py`, and `self_check.py`.
- Missing bundled helpers are `fail`; missing upstream repository validators are not applicable.

4. Reference routing
- Verify the installed `SKILL.md` links to the packaged import, export, profile, and doctor references.
- Missing references or mismatched relative paths are `fail`.

5. Common path mistakes
- Verify `SKILL.md` beneath the resolved installation root. Do not search for it
  relative to the user's current project and do not instruct users to enter the
  maintainer repository.
- Detect Windows path quoting risk when paths contain spaces and the provided command examples omit quotes.
- Detect references to local installed skill paths that do not exist (if command output includes one).
- Mark these as `warn` with a precise fix suggestion.
- A missing resolved `SKILL.md` should suggest reinstalling or updating Diagram
  Design, not changing into a repository checkout.

## Output contract

Always print:

1. A compact summary line:
- `Doctor summary: <PASS|WARN|FAIL> (<pass_count> pass, <warn_count> warn, <fail_count> fail)`

2. A checklist with one line per check:
- `[PASS] Python 3.11.9 found at ...`
- `[WARN] Playwright not installed ...`
- `[FAIL] Missing scripts/export_svg.py`

3. A `Next actions` section only when warn/fail exists.

4. If `--json` is present, append JSON object with:
- `status`, `counts`, `checks[]` (`name`, `status`, `message`, `fix` optional), `timestamp`.

## Safety and behavior rules

- Read-only diagnostics only: do not modify files, do not install packages, do not run destructive git commands.
- If any command fails unexpectedly, capture stderr and continue remaining checks.
- Never claim a check passed unless verified directly in this run.
- Prefer explicit, copy-pastable remediation commands.

## Example result

```text
Doctor summary: WARN (6 pass, 2 warn, 0 fail)
[PASS] Bundled Python 3.12 found at <runtime-path>
[WARN] Playwright package not found in active interpreter
[PASS] scripts/drawio_extract.py present
...

Next actions
- Provision an approved PNG export renderer, then re-run the doctor check
- Ask to re-run the diagnostics in strict mode
```
