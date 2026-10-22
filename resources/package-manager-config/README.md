# Package Manager Config

This directory contains optional npm and pip configuration for internal package
registries and other package manager settings. Main applies it to the application
environment and the managed Gateway and MCP processes.

Development reads these files from `resources/package-manager-config/`. Packaged
applications read them directly from `package-manager-config/` under the
installation resources directory:

- `.npmrc` enables `NPM_CONFIG_USERCONFIG`
- `pip.ini` enables `PIP_CONFIG_FILE`

The application does not copy them to the user's app-data directory.

Each file is optional. If `.npmrc` is missing, npm config is not installed or
injected. If `pip.ini` is missing, pip config is not installed or injected.

For different internal network environments, replace these files before
packaging the installer. Both configuration files are ignored by Git; keep
environment-specific values out of commits.
