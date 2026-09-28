"""Launch LiteLLM or explicitly initialize its shared database."""

import argparse
import os
from pathlib import Path
import sys
import subprocess

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent


def build_launch(mode, inherited=None):
    if mode not in {"serve", "init"}:
        raise ValueError("Unknown launch mode.")

    environment = dict(os.environ if inherited is None else inherited)
    if not (ROOT / ".env").is_file():
        raise ValueError("Create native/.env before starting the service.")

    environment.update({key: value for key, value in dotenv_values(ROOT / ".env", interpolate=False).items()
                        if value is not None})

    required = ["DATABASE_URL", "LITELLM_MASTER_KEY", "LITELLM_SALT_KEY",
                "REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD", "LITELLM_ACTIVITY_DATABASE_URL"]
    if mode == "serve":
        required += ["LITELLM_JWT_ISSUER", "LITELLM_JWT_AUDIENCE", "LITELLM_JWT_JWKS_URL", "UI_USERNAME", "UI_PASSWORD"]
    if any(not environment.get(key, "").strip() or "replace-with-" in environment[key]
           for key in required):
        raise ValueError("Complete the required deployment settings in native/.env.")

    environment["PYTHONPATH"] = os.pathsep.join([
        str(ROOT.parent), environment.get("PYTHONPATH", "")])
    environment["LITELLM_MODE"] = "PRODUCTION"
    environment["PYTHONUNBUFFERED"] = "1"
    environment["PATH"] = str(Path(sys.executable).parent) + os.pathsep + environment.get("PATH", "")

    if mode == "init":
        return [sys.executable, str(ROOT.parent / "start.py"), "init"], environment

    environment["CONFIG_FILE_PATH"] = str(ROOT / "config.yaml")
    port = environment.get("LITELLM_PORT", "9108")
    workers = environment.get("LITELLM_WORKERS", "4")
    host = environment.get("LITELLM_HOST", "127.0.0.1").strip()
    if not host or any(character.isspace() for character in host):
        raise ValueError('LITELLM_HOST must be a nonempty address.')

    for name, value, minimum, maximum in (
        ('LITELLM_PORT', port, 1, 65535),
        ('LITELLM_WORKERS', workers, 1, 256),
        ('MAX_STRING_LENGTH_PROMPT_IN_DB', environment.get('MAX_STRING_LENGTH_PROMPT_IN_DB', '2048'), 1, 1000000),
    ):
        if not value.isascii() or not value.isdigit() or not minimum <= int(value) <= maximum:
            raise ValueError(f'{name} must be an integer between {minimum} and {maximum}.')

    environment["DISABLE_SCHEMA_UPDATE"] = "true"
    command = [sys.executable, "-m", "uvicorn", "start:create_app", "--factory",
               "--app-dir", str(ROOT.parent), "--host", host, "--port", port, "--workers", workers]
    return command, environment


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", nargs="?", default="serve", choices=["serve", "init", "up"])
    args = parser.parse_args()

    try:
        command, environment = build_launch('serve' if args.mode == 'up' else args.mode)
        if args.mode == 'up':
            init_command, init_environment = build_launch('init')
            result = subprocess.run(init_command, env=init_environment, check=False)
            if result.returncode != 0:
                parser.exit(1, 'Database initialization failed; service was not started.\n')
    except ValueError as error:
        parser.exit(2, str(error) + "\n")

    os.execve(command[0], command, environment)


if __name__ == "__main__":
    main()
