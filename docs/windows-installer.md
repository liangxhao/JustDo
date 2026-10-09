# Windows installer resilience

## Scope

This note records field failures in the Windows NSIS installer and the
corresponding product guarantees:

1. a process check based on `Get-CimInstance Win32_Process` could block first
   install or upgrade when CIM returned `0x800705AF`;
2. an interactive installer started with another account's administrator
   credentials could resolve per-user paths under that credentialed account;
3. a reported install created an unbounded sequence below
   `%LOCALAPPDATA%\Temp\SampleDir\_wedax.exe\...` until the system drive filled.

The third path is not emitted anywhere in this repository. It is consistent
with an extractor, sandbox, or endpoint-security hook reacting to the packaged
executable, but the creating process must be confirmed from ProcMon or an EDR
event before attributing ownership. Setup confines application payloads and extractor temporary files to the selected
installation directory. It cannot control an independent security-product process;
that case remains an attribution and vendor-escalation issue.

## Required behavior

### Native Windows architecture

The installed Electron application and its production runtime remain x64. The
standard electron-builder NSIS installer, uninstaller, and elevation helper may
run as x86 compatibility processes during install, update, or uninstall. This
does not change the architecture of the installed application.

A PE-header audit of the release candidate found the application executable to
be AMD64, while the NSIS setup executable and packaged `resources/elevate.exe`
helper are x86. Passing `--x64` selects the application payload architecture;
it does not change the standard NSIS stub or its helper plug-ins.

Migrating the installation chain to x64 MSI solely to remove Task Manager's
temporary `32 bit` label is intentionally out of scope for this resilience fix.
Such a migration would also require compatibility work for existing NSIS
installations and the automatic-update flow. It should be evaluated and tested
as a separate project rather than combined with the account, process-check, and
temporary-storage corrections in this change.

### Process handling

- A pristine install, with no per-user or per-machine registration and an empty
  target directory, does not start the PowerShell helper. No previous process
  tree or runtime exists to protect or stage.
- Upgrade checks use `Get-Process` plus the executable path and do not depend on
  CIM/WMI.
- Process enumeration is advisory. If Windows cannot provide a trustworthy
  inventory, setup falls back to probing the installed executable for an
  exclusive file lock and then lets old-version removal/atomic copy make the
  final decision. An inspection API failure by itself never blocks setup.
- Matching remains scoped to the selected installation root. It must not kill
  another installation, a portable copy, or an unrelated process with the same
  name.
- A healthy installed application still receives the graceful update shutdown
  request before the bounded force-close fallback.
- Setup no longer moves old runtime trees into a sibling staging directory.
  Upgrades use normal old-version removal followed by the complete new payload;
  runtime transaction backups, when needed by the extractor, stay in `resources`.
  Removing the sibling optimization can make deletion of an old runtime slower.

This is an incremental hardening step. A future implementation should replace
PowerShell inspection with a small native Restart Manager/path-aware helper so
the final upgrade lock decision has no PowerShell dependency.

### Account ownership

The assisted installer continues to offer both **current user** and **all
users**. **Current user remains the default**; setup does not force either
mode.

For an interactive installer that starts elevated outside electron-builder's
own UAC inner instance, setup re-launches itself once through the current
desktop shell before it reads `APPDATA` or `LOCALAPPDATA`. This handles “Run as
administrator” with credentials from an old account. If the user later selects
all users, the normal multi-user page performs the explicit elevation.
If the desktop shell is unavailable, an interactive elevated setup offers to
restart explicitly in `/allusers` mode; it never silently treats the credential
account as the selected current user.

Silent installs do not require a desktop-shell relaunch. They run as the
invoking account and let electron-builder resolve `/currentuser`, `/allusers`,
or the existing installation mode normally. For `/currentuser`, the invoking
account is the target user, including when launched from an elevated shell.
This preserves completion and exit-code semantics for deployment automation.

### Temporary storage

- The resource extractor receives a unique temporary directory below the
  selected installation root through `TEMP`, `TMP`, and
  `JUSTDO_INSTALLER_TEMP_ROOT`.
- The extractor validates that its temporary root is a direct, session-named
  child of the selected installation root, refuses recursive cleanup when a
  reparse point is present, and removes that root on success. On failure it
  preserves progress/error files until setup has read the actual cause; setup
  then deletes those files and removes the empty root without recursion. This
  also covers the common case where setup is forcibly closed but the extractor
  is allowed to finish. Setup restores its original environment and only tries
  a non-recursive removal of the now-empty root; a locked or suspicious residual
  is retained and recorded instead of being deleted across an uncertain path.
- Setup refuses cancellation while the asynchronous extractor is active, so
  closing the wizard cannot orphan a child that continues writing.
- Resource processes launch hidden through `CreateProcessW`, with inherited
  stdout/stderr handles writing `resources/install-extractor-stdio-<session>.log`.
  This captures Electron and script-load failures before the script's own logger
  starts. The installer polls the real process handle and appends captured bytes
  unchanged to the resource log after exit. Failure retains the capture in the
  installation directory; success removes it only after the append succeeds.
  An unavailable capture/resource log does not block an otherwise working extractor.
- The application shell archive is staged in the installation directory and
  extracted directly there after the previous version is removed. The default
  full-payload staging copy in user TEMP is removed by composing upstream NSIS
  templates at the project-scoped final-script build seam. The ordinary two-pass
  signed-uninstaller generation is retained; no custom `nsis.script` is configured. Only small NSIS bootstrap DLLs/helpers still use the
  Windows temporary directory before the installation directory is selected.
- Shell extraction uses the bundled 32-bit 7za CLI, not the error-suppressing
  Nsis7z plugin. A real file-write or decode failure returns a nonzero result and
  records complete UTF-8 output. Failure keeps `.justdo-shell-<session>.log` in the
  installation root; success removes it after appending it to the resource log.
  A missing/unwritable profile log does not prevent extraction. The helper and
  archive are removed on success; 7-Zip license notices remain in the installation
  root. Build-time package/CRC checks remain, without the obsolete plugin codec
  allowlist.
- No free-space reserve, system-temp disk monitor, total extraction deadline or
  Python process/import check rejects an otherwise writable installation. Actual
  extraction/write errors still fail setup and restore the runtime backups.
- Native tar failures retry with the bundled npm tar extractor, including failures
  on older Windows tar implementations. Both attempts are logged.
- Plugin directory declarations are ordered before custom includes, avoiding the
  upstream asynchronous header race that can report a missing UAC plugin while
  compiling the uninstaller. A final failure
  includes its actual cause in the dialog, not only exit code 1.
- Resource metadata is optional and supplies progress only. Basic application and
  runtime files remain checked for an incomplete payload; detailed Python readiness
  belongs to startup. Runtime/package validation happens during packaging.

### Upgrade and uninstall data ownership

Setup does not read, initialize, copy resources into, or clean up userData. Only
`install-timing.log` and `install-resource.log` may be appended below the
initiating user's `%APPDATA%/<productName>`. If that location cannot accept logs,
setup continues. After the final installation directory is established and the
old version is removed, lifecycle logs can use `<install>/logs`; the extractor
also retains a fallback `resources/install-resource.log` when its requested log
cannot be written. No alternate user profile, system TEMP or setup-EXE directory
is selected as a log destination.
The upstream copy of the setup EXE into the Local AppData updater cache is also
removed. Subsequent updater downloads remain owned by the running application.
Windows shortcuts and uninstall registry entries retain their normal OS locations.

The first application launch creates the actual user-data directory and opens the
product database. The first-launch in-memory initialization window can report errors before
persistent browser profiles open. Later successful launches use one normal window;
a data-directory failure can still open the same error screen. The home screen shows four completed milestones:
user data, local runtime, application configuration, and Gateway startup. These are
step counts, not an invented byte/time percentage. After SQLite opens, it hands off
to the normal application window while preserving the initialization state.
The Renderer subscribes before reading its snapshot and mounts the normal app only
when Main reports readiness. Failures retain the failed step, directory and actual
error, with a restart action; reinstalling is unnecessary for a profile problem.

Both the in-memory initialization window and the normal packaged window use the
application-owned loopback HTTP renderer loader and its immutable-asset/CSP guards.
Inline-script CSP hashes follow browser line-ending normalization, including
Windows-built entries, without allowing arbitrary inline scripts.
Startup waits for the initialization page's actual load, including asynchronous
host preparation, before opening SQLite. A load failure is logged and does not
add a fatal startup gate. The normal Renderer retains preference hydration before
App/Redux imports.

Main writes `.justdo-initialized` after preparing the usable local application
shell. Dependency environment setup, Python preparation, default-project creation, configuration synchronization,
Gateway readiness and writing this presentation marker do not add fatal startup
gates. Their failures are logged, with Settings and the existing runtime status
still available for recovery. Actual user-directory/database failures retain the
failure screen. Interrupted local preparation retries next launch. Existing
Windows profiles without this marker show the setup progress once
without deleting their data. Development and other platforms do not write the
Windows marker. Legacy Python cleanup now occurs only in the running application's
existing runtime readiness flow; legacy dependency config copies remain untouched.

### Startup resource ownership

The packaged OpenClaw runtime, built-in skills/hooks/extensions, Python and its
bundled packages, MinGit, npm, dependency-manager configuration and local speech
runtime are read directly from the installation resources. Startup does not
duplicate these bundles into userData.

The main assistant seeds only `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md` and
`BOOTSTRAP.md` from the bundled role templates into
`openclaw/state/agent-workspaces/main`. These are editable, per-user role files;
seeding preserves existing files and completes once. The installation templates
remain the defaults for other profiles.

Databases, native conversation state, configuration, credentials, browser state
and logs are writable user data. The small Node/npm/npx launch scripts and browser
native-messaging configuration are generated with the actual executable/resource
paths; their executables stay in the installation directory. User-imported skills,
downloaded speech models and additional Python packages are installed on demand.
Preparing the bundled Python environment sets its user-package paths without
creating empty user-package directories; pip creates them when a package is
actually installed.

### Startup diagnostics and review coverage

Main logs retain the failed operation, initialization step, filesystem path,
error code, stack and nested cause where available. Window observers capture
preload errors, load errors and application-frame Renderer warnings/errors;
Renderer uncaught errors and unhandled rejections keep stacks and source locations.
Console messages from external browser/preview frames and normal chat output are
not collected by this observer. The shared credential masker is applied before persistent log writes.

Log writes use real append operations, rather than an extra writability probe or
electron-log's cached NullFile. If the primary log directory fails, Main tries
`<install>/logs`; rotation, pruning and export errors do not block startup. The
failure screen shows the active log path, and log export includes both primary
and fallback files. If both allowed locations are unwritable, the console remains
available and later actual writes can recover. A process killed before JavaScript
starts, or a completely unwritable disk, cannot be guaranteed a persisted log.

Review checks include compiled installer/uninstaller templates, real extraction
with a locked output file and a corrupt archive, Chinese/space/`% & !` paths,
unavailable profile logs, resource rollback and fallback extraction, optional
startup failures, marker-write failures, delayed initialization snapshots,
Renderer errors, and user-log failures at startup or after successful writes.

Interactive uninstall exposes an unchecked optional component for deleting all
local user data. Without that explicit selection, uninstall removes application
files but preserves Roaming and Local app-data directories. Selecting it removes
the current user's product/package-name variants below `%APPDATA%` and
`%LOCALAPPDATA%`, plus the package updater cache; external projects, downloads,
and workspaces remain untouched.
For an all-users uninstall, deletion runs synchronously in the initiating
desktop user's context rather than an administrator credential account. The
cleanup does not traverse junctions or symbolic links, and a partial failure is
reported with a retry choice. Silent upgrade uninstall never selects the
destructive component. A directly elevated uninstall without an outer user
process only deletes profile data if that account owns the current desktop;
if the account cannot be confirmed, uninstall finishes and reports that data
was retained. This check applies only to the optional destructive cleanup.
The legacy electron-builder `--delete-app-data` switch is rejected before
uninstall starts because its built-in deletion bypasses these safeguards.
Use the interactive checkbox to request data deletion instead.

## Diagnostics

The lifecycle log remains `install-timing.log`; resource extraction details are
in `install-resource.log`. Both files are append-only across installer runs.
NSIS uses Windows append-only handles so callback writes and overlapping
installer processes cannot overwrite records through stale file offsets.
Log directory failures are non-fatal. Both logs prefer the initiating user's
Roaming product directory. After old-version removal, setup can use
`<install>/logs`; resource extraction can use `resources/install-resource.log`.
No alternate profile or cache location is created.
Each run is wrapped in prominent `INSTALL SESSION START` / `INSTALL SESSION END`
separators containing its timestamp, PID, session ID, version, and terminal
state, so repeated installs remain distinguishable without erasing prior
diagnostics. Resource-extractor records also carry the same session ID.
Success/failure callbacks also close silent sessions. A forcibly terminated
process may leave a START without an END; the next run still appends a new block.
Relevant events are:

- `phase=process-check-skipped reason=pristine-install`
- `extractor-temp-root`
- `event=archive-extractor-failed` (native attempt; a fallback may still succeed)
- `event=resource-install-failed` (final failure with its actual cause)

For a future recurrence of `SampleDir`, collect a Process Monitor trace filtered
to `Path begins with <reported SampleDir>` and include Process Name, PID,
Operation, Result, and the process tree. Do not collect file contents or command
lines containing credentials.

## Verification

- Static installer contract tests cover current-user bootstrap ordering,
  preservation of the multi-user choices, the fresh-install process skip,
  removal of CIM usage, install-root payload/temp isolation, cleanup and log ownership.
- Windows integration tests execute the process helper against real processes
  and exercise resource extraction/rollback fixtures, including irrelevant disk
  changes, native-extractor fallback, rollback, and managed-temp cleanup.
- A release candidate should additionally be installed in two Windows accounts:
  choose current user after launching normally, choose current user after
  starting with alternate administrator credentials, and choose all users from
  a non-admin account.
- A release check should continue to assert that the installed main executable
  and production native modules are x64. The check must distinguish these from
  the intentionally x86 NSIS installer, uninstaller, and elevation helper.
