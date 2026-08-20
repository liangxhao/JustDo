"""Add JustDo's persistent per-user package directory to embedded Python."""

import os
import sys


def _add_justdo_user_sites() -> None:
    user_sites = [
        os.environ.get("JUSTDO_PYTHON_USER_SITE", "").strip(),
    ]
    user_sites = [entry for entry in user_sites if entry]
    if not user_sites:
        return

    managed_site = os.path.normcase(
        os.path.join(sys.prefix, "Lib", "bundled-site-packages")
    )
    normalized_user_sites = {
        os.path.normcase(os.path.abspath(entry)) for entry in user_sites
    }
    sys.path[:] = [
        entry
        for entry in sys.path
        if os.path.normcase(os.path.abspath(entry)) not in normalized_user_sites
    ]
    managed_index = next(
        (
            index
            for index, entry in enumerate(sys.path)
            if os.path.normcase(os.path.abspath(entry)) == managed_site
        ),
        len(sys.path),
    )
    sys.path[managed_index:managed_index] = user_sites

    pip_args = [argument.lower() for argument in sys.argv[1:]]
    conflicting_options = ("--target", "-t", "--prefix", "--root", "--user", "--no-user")
    has_conflicting_option = any(
        argument == option or argument.startswith(f"{option}=")
        for argument in pip_args
        for option in conflicting_options
    )
    if "install" in pip_args and not has_conflicting_option:
        os.environ.setdefault("PIP_USER", "true")


_add_justdo_user_sites()
