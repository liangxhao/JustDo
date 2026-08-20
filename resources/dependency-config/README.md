# Dependency Manager Config

This directory contains optional dependency download configuration used by
packaged application builds.

Packaged applications use these files directly from the installation resources
directory:

- `.npmrc` enables `NPM_CONFIG_USERCONFIG`
- `pip.ini` enables `PIP_CONFIG_FILE`

The application does not copy them to the user's app-data directory. Windows
upgrades remove the two legacy app-data copies created by earlier installers.

Each file is optional. If `.npmrc` is missing, npm config is not installed or
injected. If `pip.ini` is missing, pip config is not installed or injected.

For different internal network environments, replace these files before
packaging the installer.
