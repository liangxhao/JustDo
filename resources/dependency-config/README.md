# Dependency Manager Config

This directory contains optional dependency download configuration templates
used by packaged JustDo builds.

During Windows installation, files in this directory are copied to the user's
JustDo app data directory:

- `.npmrc` -> `%APPDATA%\JustDo\dependency-config\.npmrc`
- `pip.ini` -> `%APPDATA%\JustDo\dependency-config\pip.ini`

At runtime, JustDo also syncs these files and injects the corresponding
environment variables for managed subprocesses:

- `.npmrc` enables `NPM_CONFIG_USERCONFIG`
- `pip.ini` enables `PIP_CONFIG_FILE`

Each file is optional. If `.npmrc` is missing, npm config is not installed or
injected. If `pip.ini` is missing, pip config is not installed or injected.

For different internal network environments, replace these files before
packaging the installer.
