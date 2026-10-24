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

### Data compatibility after installation

Setup replaces application payloads; it does not open or migrate a user's databases.
Main checks each actual profile before opening its product Store, rewriting runtime
configuration or admitting Gateway. It distinguishes migration upgrade, normal
upgrade, first installation and normal startup. Normal upgrades preserve existing
data and use the target runtime's declared schema range and native maintenance.

A decrease in either application or runtime version pauses startup with a
localized warning and a “Start anyway” button. Human confirmation resumes the
same normal startup checks for the exact current target; it neither marks startup
ready nor persists a bypass. Unsupported data or loading failures still report
their actual errors and preserve files. Uncomparable versions are not inferred
to be compatible. See
[startup and history upgrades](features/app/startup-and-history-upgrade.md).

This is a data-use admission rule in builds containing this policy, not a claim
that every historical installer prevents copying an older executable. Historical
builds without the rule cannot be protected retroactively. Per-machine setup and
automatic-update version selection do not substitute for per-profile data checks.

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

Main classifies the active data generation before opening the product Store or Gateway.
A fresh profile uses the four-step setup. A published JSONL profile first receives a
verified selective history backup, then a fresh environment, native history import,
metadata restoration and startup checks. Current SQLite users retain their settings
and take ordinary startup, including overwrite/reinstall without the old presentation
marker. Unknown/mixed formats preserve the profile and expose a recovery error.
Unfinished transactions resume at their confirmed stage. An uncommitted backup
candidate is retained and refreshed; a prepared target environment is not replaced.
See [startup and history upgrade](features/app/startup-and-history-upgrade.md).

The owning startup module is `app/shell/startup/`, with `routing`, `history` and
`initialization` submodules, mirrored by Main's startup domain. First setup and history
upgrade share one guide; ordinary startup shows the current operation without setup
steps. Main freezes route, first-launch mode and one animation clock for every window.
The in-memory transient guide hands off after the new product Store opens; no old
persistent profile is opened before migration admission. The Renderer subscribes before
reading its snapshot and keeps the destination inert until App and its first workspace
are actually ready. Main failures offer restart; Renderer failures offer reload, with
actual errors and diagnostics retained.

All routes use the bundled soft-light gathering entry: a visible centered mark settles
into the brand position while content appears, over 1280ms. The shared Main clock
continues across transient/normal windows, static HTML, React and snapshot handoffs.
After real readiness, two panels reveal the mounted home page over 640ms. Failure
cancels entry/reveal immediately; late completion cannot open the destination. Motion
never advances data milestones. Locale preference persistence no longer blocks UI
readiness; critical unread configuration stays an error, retaining the original exception.
Its copy is maintained separately in
`startupTranslations.ts`; guide copy remains in `initializationTranslations.ts`.
Opening an existing database and synchronizing AI runtime settings are not labeled
as creating user data or preparing default files on subsequent launches.
Both modules show the current operation and its explanation.
Main publishes closed activity identifiers at the actual
directory/database, bundled runtime, startup settings, workspace, default files,
engine startup and finalization boundaries. Setup copy focuses on local folders,
data files, default assistant files, runtime resources and startup checks.
Model access, proxy application, local services and integration setup have their
own activity descriptions within the existing configuration milestone. Their
ownership and execution order are unchanged.
There is no assertion that large runtime bundles are copied into Roaming; their
installation-resource ownership remains as described below.
The shared snapshot carries startup, activity-start and last-update
timestamps, preserving elapsed time across the transient-to-normal window handoff.
Renderer updates total and current-operation elapsed time every second; timers do
not advance completed milestones or assert backend health. After 30 seconds on
one operation it explains possible delays, and after 90 seconds without an activity
change it explicitly reports the lack of further progress. A new real activity
resets that hint. Failures freeze elapsed time and expand the data/log locations;
normal setup keeps those details collapsed. These presentation updates do not add
startup gates, public downloads, or retry execution.
First-launch and subsequent-launch animations, indeterminate tracks and progress-width
transitions remain enabled when Windows animations are disabled or reduced motion is
requested. Actual startup failures still stop the ordinary screen's activity pulse and track.

The HTML entry includes separate first-launch and ordinary-launch templates, their
own CSS and build-injected bilingual copy. It selects the fixed mode synchronously,
so first paint does not wait for React, editor resources or asynchronous preference hydration.
Each ordinary document's preload synchronously reads only the saved appearance mode
and named palette from Main before first paint, after the existing preference import.
The window-local channel admits only its main frame and is removed on destruction;
reload reads current settings instead of reusing construction-time values. The entry embeds the existing
theme CSS and uses the same palette resolver as ThemeService; it does not infer the
app theme from the OS or origin-local configuration. Before the product Store opens,
the transient first-launch window skips that IPC and uses the product's default light theme. Loading
the full stylesheet, preferences or App therefore does not switch startup colors.
It shows elapsed time and an explicit reload action for module-load failures.
The lightweight initialization Gate loads after preference hydration; it defers
Monaco, App and Redux imports until Main reports shell readiness. Renderer work
then names its actual settings, theme, language and conversation-loading operation
inside the same presentation. The current-operation clock starts anew on entering
Renderer loading; total elapsed time retains Main's start time.
Unmeasured interface work uses an indeterminate track instead of fabricated percentages.
Ordinary Gateway startup remains asynchronous and the title-bar status reports its
actual lifecycle; completing the startup handoff does not claim engine readiness.

Both the in-memory initialization window and the normal packaged window use the
application-owned loopback HTTP renderer loader and its immutable-asset/CSP guards.
Inline-script CSP hashes follow browser line-ending normalization, including
Windows-built entries, without allowing arbitrary inline scripts.
Startup waits for the initialization page's actual load, including asynchronous
host preparation, before opening SQLite. A load failure is logged and does not
add a fatal startup gate. The normal Renderer retains preference hydration before
App/Redux imports.

Main retains `.justdo-initialized` as an optional presentation receipt after
first setup or history upgrade; data-generation admission and `startup-state.json`
own routing. A current profile without that receipt still takes ordinary startup.
Normal dependency/default-resource readiness tasks retain their existing optional
failure handling. History backup, native import, exact identity verification and
historical-owner projection must succeed before history admission. Directory/database
failures preserve a recovery screen. Interrupted preparation resumes on the next launch.
Legacy Python cleanup occurs only in the application's existing runtime readiness flow.

### Startup resource ownership

The packaged OpenClaw runtime, built-in skills/hooks/extensions, Python and its
bundled packages, MinGit, npm, dependency-manager configuration and local speech
runtime are read directly from the installation resources. Startup does not
duplicate these bundles into userData.

Tracked Python preparation inputs live in `resources/python/`, and download
caches are grouped under the repository-root `cache/`. Prepared Python, Git and
speech payloads live in `build/runtimes/{python-win,mingit,local-tts}/`, shared by
development and packaging. Windows runtime archives are generated in `build/tar/`;
installation resource directory names remain `python-win/`, `mingit/` and `local-tts/`. Tray
assets come from `resources/icons/tray/` and are installed as `resources/tray/`.
The inert preference reader is packaged at
`resources/pages/renderer-preferences.html` inside the application package.

Optional npm and pip configuration comes from `resources/package-manager-config/`
and is packaged as `resources/package-manager-config/` below the installation
root. Main reads `.npmrc` and `pip.ini` directly from that directory. Each file is
optional and ignored by Git; supply the environment-specific files before
packaging.

Packaged Windows startup consumes the prepared Gateway launcher and runtime
preload as regular, non-empty files. Main loads the actual preload rather than
serializing its own bundled function text: minification changes `toString()`
output and must never cause an installation-directory rewrite. Missing files
fail runtime readiness clearly; packaged startup does not regenerate them or
extract an older ASAR fallback. Development and resource preparation retain
their generation flow. Release verification exercises the minified Main and
compares all installed resources before and after first and subsequent startup.

The per-user Node preload also reads the configured CA bundle through Node's
Unicode-aware filesystem API before application code runs. It merges those
certificates with the default and system roots for Gateway, Node/npm shims and
the explicit MCP preload. This covers Windows OpenSSL's failure to open some
Unicode CA paths without disabling certificate validation or changing the
system certificate store. Ordinary MCP processes do not gain the Gateway's
private CA or proxy capability implicitly; their existing environment policy
remains authoritative. The native startup warning can remain; release
checks require trusted loopback TLS to succeed and unrelated CAs to fail.

The main assistant seeds only `AGENTS.md`, `SOUL.md`, `IDENTITY.md` and `USER.md`
from the bundled role templates into
`openclaw/state/agent-workspaces/main`. These are editable, per-user role files;
seeding preserves existing files and completes once. `BOOTSTRAP.md` is optional
and is not created automatically: native onboarding cannot complete from a
project session with a separate role home. Existing onboarding files remain
user-managed. Other profiles obtain role files through the settings editor or
the creation tool; selecting a preset prepares an editable `AGENTS.md` draft.

Databases, native conversation state, configuration, credentials, browser state
and logs are writable user data. The small Node/npm/npx launch scripts and browser
native-messaging configuration are generated with the actual executable/resource
paths; their executables stay in the installation directory. User-imported skills,
downloaded speech models and additional Python packages are installed on demand.
Preparing the bundled Python environment sets its user-package paths without
creating empty user-package directories; pip creates them when a package is
actually installed.

### Agent console CLI

Packaging installs `<productName lowercase>-cli.exe` beside the desktop executable.
It handles help and version locally and relays commands or ACP stdio through Main's
authenticated local pipe. Enable CLI access and copy its full path from settings;
installation does not mutate Windows PATH or start a second Gateway. The existing
Multica command remains available through its independent setting.

ACP and MCP dependencies are bundled at build time. Runtime Services' resource-sync
and TypeScript precompile paths both include the MCP SDK and its schema validator,
without adding a separate runtime npm installation. Validate the installed console
under Chinese and space-containing paths without system Node, public network or
warmed caches. The command and protocol contract is in
[Agent CLI / ACP](features/integrations/agent-cli.md).

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

### Release resource selection

Windows runtime archives use Zstandard level 19 with long-distance matching and
a 64 MiB window. The installer's default decoder limit remains unchanged.
Same-input, same-window release measurements compare size, decode time and
memory: the higher level primarily costs build time. Complete resource extraction
is measured separately before release. Python bytecode caches,
the Control UI's precompressed representations and native asset manifest remain
intact.

Windows builds reuse the complete prepared OpenClaw runtime only after its target,
source proof, build recipe, bundle and all patches verify. A missing/stale proof
triggers a full rebuild from the locked pristine npm package, followed by another
verification; no hashes are refreshed in place. `OPENCLAW_FORCE_INSTALL=1` always
forces that rebuild, including on repeated builds. Local resources and final
packaged artifacts still pass their normal checks on every build.

Python, MinGit and local speech preparation run in three separate processes with
disjoint resource roots. All must finish successfully before archiving; a failure
waits for the remaining processes before reporting the error. Windows' npm build
entry no longer prepares Python/Git a second time before this packaging step.

Runtime compression uses an isolated Node process with up to four native Zstd
workers when CPU and available memory permit. It retains level 19, long-distance
matching and the 64 MiB decoder window. Buffered compression is limited to 1 GiB
inputs with conservative input/output and per-worker memory headroom; smaller
machines and larger inputs use streaming single-thread compression. Node 24's
streaming multi-worker path failed the large-archive regression, so only the
buffered child uses native parallel compression. The child exits before Electron
packaging continues, releasing its buffers. Output is published only on success.
`RUNTIME_COMPRESSION_WORKERS=0` explicitly selects streaming; values 2–8 set a
requested worker count, still bounded by CPU and memory. No extra compressor is
downloaded or installed, and installer decoding is unchanged.

Runtime pruning removes native PDB symbols and source files only from reviewed
SDK packages with compiled entry points present. Markdown is retained. Packaging
preserves the complete native `docs/` and `skills/` trees, including names such
as `README.md` and `examples/`, and checks their inventory against the archive.
Python, MinGit, FFmpeg and speech runtime capabilities remain bundled.
License, copying, copyright and notice files/directories are retained for every
bundled dependency, including filtered development trees. Packaging checks the
runtime archive's legal-file inventory and the application's notices against
their source bytes; these materials are not treated as removable documentation.

Windows MXC keeps its selected Windows executables and WSL DLLs while excluding
the Linux `lxc-exec`. The application keeps its target architecture's node-pty
prebuilds and removes other architectures and redundant `third_party` copies.
draw.io removes Java-server directories and source maps during its own asset
preparation, before generating the closed integrity manifest; generic packaging
continues to copy that prepared set unchanged.

### Build-time extension staging

Local extension assembly retries `EACCES`, `EBUSY` and `EPERM` directory
renames five times at 200 ms intervals. If renaming remains blocked, assembly
copies the prepared tree into an exclusively created destination instead.
An existing destination or a failed copy still fails packaging; an incomplete
extension is never accepted as a successful assembly. The staging tree is
cleaned by the assembly caller. Persistent file-read/write denial requires
checking processes using the development runtime, directory permissions and
endpoint-security events; `EPERM` alone does not identify the blocking process.

The lifecycle log remains `install-timing.log`; resource extraction details are
in `install-resource.log`. Both files are append-only across installer runs.
NSIS uses Windows append-only handles so callback writes and overlapping
installer processes cannot overwrite records through stale file offsets.
Log directory failures are non-fatal. Both logs prefer the initiating user's
Roaming product directory. An elevated inner instance obtains the outer user's
paths before its first log selection or write, including silent upgrades, so
alternate administrator credentials never select that administrator's logs.
After old-version removal, setup can use
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

Packaged runtimes omit `dist/worker-artifacts/`, the standalone Worker deployment
bundle. Direct local execution remains supported; independent Worker environments
and paired node-host execution (including a node on the same PC) are outside this
distribution. All ordinary local `.worker.js` entries, runtime knowledge and legal
metadata remain. Archive validation rejects deployment bundles and missing local
Workers. The pristine source runtime and its original inventories stay complete;
packaging does not rewrite source proofs to conceal the intentional omission.
Compression settings are unchanged by this removal.

The default deployment has no update feed. An empty address does
not produce `app-update.yml`, an update-configuration marker, `latest.yml` or
release history. Packaging also removes stale copies of those files. Installed
startup enables automatic checks only when the NSIS installation marker, a
non-empty explicit generic feed and the matching configuration marker agree.
Configured URLs are used without hostname filtering; their availability is
the deployment's responsibility.
Deployments configure their internal feed in `src/config/appUpdate.ts` before
rebuilding; inherited environment variables cannot silently enable networking.

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

## Bundled Node for OpenClaw 2026.10.6

The Gateway and native CLI use the complete pinned Node 24.22.1 distribution inside the OpenClaw runtime at `node-runtime/`. Electron remains the UI and product-database host. The runtime manifest binds the Node manifest; freeze and archive verification validate the full file tree, npm/npx, symlink topology and executable bytes. Missing or changed files fail preparation instead of selecting an external Node or downloading on first launch. Windows archive extraction preserves this exact subtree and its license files. Preparation inputs are listed only in [offline downloads](offline-downloads.md). macOS signing/notarization and other architecture installation checks require separate platform acceptance.
