# Windows installer resilience

## Scope

This note records three field failures in the Windows NSIS installer and the
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
event before attributing ownership. The installer can bound its own extractor
and direct child processes; it cannot terminate an independent security-product
process, so that case remains an attribution and vendor-escalation issue.

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
- Managed-runtime staging is an upgrade performance optimization. Historical,
  unexpected, or inaccessible staging data is recorded but does not block the
  new installation; the normal old-tree removal and complete new runtime remain
  authoritative.

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
  reparse point is present, and removes that root on success or failure. This
  also covers the common case where setup is forcibly closed but the extractor
  is allowed to finish. Setup restores its original environment and only tries
  a non-recursive removal of the now-empty root; a locked or suspicious residual
  is retained and recorded instead of being deleted across an uncertain path.
- Setup refuses cancellation while the asynchronous extractor is active, so
  closing the wizard cannot orphan a child that continues writing.
- The extractor monitors free-space change on both the destination volume and
  the original user-temp volume, reserves 2 GiB, and verifies that the
  destination can hold the declared expansion before starting. It allows room
  for filesystem overhead and unrelated I/O, but terminates controlled
  extraction when either the growth budget or free-space floor is crossed.
- The guard logs `unexpected-disk-growth`; it does not recursively delete an
  unrecognized `SampleDir`, because ownership cannot be proven safely.

### Upgrade and uninstall data ownership

Upgrade cleanup is deliberately narrow. Setup removes only obsolete,
installer-owned app-data resources whose replacements are already packaged:

- `%APPDATA%/<productName>/runtimes/python-win`, the unused legacy Python
  runtime; failure to remove it is non-fatal;
- the legacy `dependency-config/.npmrc` and `dependency-config/pip.ini` files.

Setup preserves the application database, OpenClaw state and transcripts,
provider configuration and secrets, Chromium profile data, browser import
database, local speech models, logs, and unknown files under userData. It never
deletes the default `~/<productName lowercase>/project` directory or another
user-selected workspace.

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
Log directory failures fall back to another writable location; if none is
available, installation continues without persistent diagnostics.
Each run is wrapped in prominent `INSTALL SESSION START` / `INSTALL SESSION END`
separators containing its timestamp, PID, session ID, version, and terminal
state, so repeated installs remain distinguishable without erasing prior
diagnostics. Resource-extractor records also carry the same session ID.
Success/failure callbacks also close silent sessions. A forcibly terminated
process may leave a START without an END; the next run still appends a new block.
Relevant events are:

- `phase=process-check-skipped reason=pristine-install`
- `extractor-temp-root`
- `event=disk-growth-guard-started`
- `event=unexpected-disk-growth`

For a future recurrence of `SampleDir`, collect a Process Monitor trace filtered
to `Path begins with <reported SampleDir>` and include Process Name, PID,
Operation, Result, and the process tree. Do not collect file contents or command
lines containing credentials.

## Verification

- Static installer contract tests cover current-user bootstrap ordering,
  preservation of the multi-user choices, the fresh-install process skip,
  removal of CIM usage, temp isolation, cleanup, and the disk-growth guard.
- Windows integration tests execute the process helper against real processes
  and exercise resource extraction/rollback fixtures, including abnormal disk
  growth, fallback-loader failure contracts, and managed-temp cleanup.
- A release candidate should additionally be installed in two Windows accounts:
  choose current user after launching normally, choose current user after
  starting with alternate administrator credentials, and choose all users from
  a non-admin account.
- A release check should continue to assert that the installed main executable
  and production native modules are x64. The check must distinguish these from
  the intentionally x86 NSIS installer, uninstaller, and elevation helper.
