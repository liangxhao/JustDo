`npm test` runs this plugin's business tests with its own Vitest configuration.
The UI fixtures install caller-owned implementations of the public App SDK ports:
metadata, drafts, dialogs, rendering and native-history presentation. They do not
load an Electron bridge, the application store or application chat implementation.
Each test can supply its own port results and native-history state; native
admission remains the host's responsibility.

`tests/host/` contains explicit application integration tests and is excluded from
the independent suite. The application test runner supplies `APP_PLUGIN_HOST_ROOT`
when running that boundary coverage. In particular, native history connection,
retry and preparation behavior remains covered there rather than being emulated
by the plugin's browser fixture.

For a test environment with an already prepared compatible SQLite driver,
`APP_PLUGIN_TEST_SQLITE_MODULE` may explicitly name its module entry. With no
override the suite resolves its declared `better-sqlite3` dependency normally;
it never searches for an application installation or another workspace.
