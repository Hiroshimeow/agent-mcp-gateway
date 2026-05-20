import argparse
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip("\"'")
        values[key.strip()] = value
    return values


def run(args: list[str]) -> None:
    completed = subprocess.run(args, cwd=ROOT)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the local Agent MCP Gateway.")
    parser.add_argument("--repo", default=None, help="Trusted repo root. Defaults to REPO_ROOT from .env, then current directory.")
    parser.add_argument("--ip", default=None, help="Bind IP/host. Defaults to MCP_GATEWAY_HOST, then 127.0.0.1.")
    parser.add_argument("--port", type=int, default=None, help="Bind port. Defaults to MCP_GATEWAY_PORT, then 8101.")
    parser.add_argument("--token", default=None, help="OAuth password and Bearer token. Defaults to env token/password or a generated token.")
    parser.add_argument("--no-install", action="store_true", help="Do not run npm install when node_modules is missing.")
    args = parser.parse_args()

    if shutil.which("node") is None or shutil.which("npm") is None:
        print("Node.js LTS with npm is required.", file=sys.stderr)
        return 1

    env = {key: value for key, value in load_dotenv(ROOT / ".env").items() if value}
    env.update(os.environ)

    repo_root = Path(args.repo or os.getcwd()).expanduser().resolve()
    if not repo_root.exists():
        print(f"Repo root does not exist: {repo_root}", file=sys.stderr)
        return 1

    bind_host = args.ip or "127.0.0.1"
    port = args.port or 8101
    token = args.token or env.get("MCP_BEARER_TOKEN") or env.get("MCP_AUTH_PASSWORD") or secrets.token_urlsafe(24)
    advertised_host = env.get("MCP_ADVERTISE_HOST") or ("127.0.0.1" if bind_host == "0.0.0.0" else bind_host)

    if not args.no_install and not (ROOT / "node_modules").exists():
        run(["npm", "install", "--no-fund", "--no-audit"])

    logs_dir = ROOT / "logs"
    logs_dir.mkdir(exist_ok=True)

    env.update(
        {
            "REPO_ROOT": str(repo_root),
            "MCP_GATEWAY_HOST": bind_host,
            "MCP_ADVERTISE_HOST": advertised_host,
            "MCP_GATEWAY_PORT": str(port),
            "MCP_AUTH_PASSWORD": token,
            "MCP_BEARER_TOKEN": token,
            "AUTH_STATE_PATH": str(logs_dir / "auth-state.json"),
            "FILESYSTEM_LOG_PATH": str(logs_dir / "filesystem-main.log"),
            "SHELL_LOG_PATH": str(logs_dir / "shell-main.log"),
        }
    )

    print(f"MCP endpoint: http://{advertised_host}:{port}/mcp")
    print(f"Bearer token: {token}")
    print(f"Trusted repo root: {repo_root}")

    subprocess.run(["node", str(ROOT / "scripts" / "authenticated-mcp-wrapper.mjs")], cwd=ROOT, env=env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
