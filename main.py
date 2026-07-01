import argparse
import os
import secrets
import shutil
import subprocess
import sys
import time
import tomllib
import urllib.request
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


def load_toml(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        with path.open('rb') as handle:
            return tomllib.load(handle)
    except tomllib.TOMLDecodeError as exc:
        print(f"Warning: failed to parse {path}: {exc}", file=sys.stderr, flush=True)
        return {}


def env_flag(value: str | None, default: bool = False) -> bool:
    text = str(value or '').strip().lower()
    if not text:
        return default
    if text in {'1', 'true', 'yes', 'y', 'on'}:
        return True
    if text in {'0', 'false', 'no', 'n', 'off'}:
        return False
    return default


def gateway_config_path(env: dict[str, str]) -> Path:
    configured = env.get('MCP_UPSTREAM_CONFIG') or ''
    return Path(configured).expanduser().resolve() if configured else ROOT / 'config' / 'mcp-servers.toml'


def load_openai_tunnel_config(env: dict[str, str]) -> dict[str, object]:
    config = load_toml(gateway_config_path(env)).get('openai_tunnel') or {}
    if not isinstance(config, dict):
        return {'enabled': False, 'profile': 'local-gpt', 'command': 'tunnel-client'}
    return {
        'enabled': bool(config.get('enabled', False)),
        'profile': str(config.get('profile') or 'local-gpt'),
        'command': str(config.get('command') or 'tunnel-client'),
    }


def local_gateway_base_url(bind_host: str, port: int) -> str:
    local_host = '127.0.0.1' if bind_host in {'0.0.0.0', '::'} else bind_host
    return f'http://{local_host}:{port}'


def wait_for_gateway(base_url: str, process: subprocess.Popen, timeout_seconds: float = 30.0) -> None:
    health_url = f"{base_url.rstrip('/')}/healthz"
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f'MCP gateway exited before becoming ready: code={process.returncode}')
        try:
            with urllib.request.urlopen(health_url, timeout=1) as response:
                if response.status < 500:
                    return
        except Exception as exc:  # noqa: BLE001 - report the final readiness error.
            last_error = exc
        time.sleep(0.5)
    suffix = f': {last_error}' if last_error else ''
    raise RuntimeError(f'MCP gateway did not become ready at {health_url}{suffix}')


def resolve_executable(command: str) -> str | None:
    if Path(command).exists():
        return command
    return shutil.which(command)


def start_openai_tunnel(tunnel_config: dict[str, object], env: dict[str, str], gateway_base_url: str) -> subprocess.Popen:
    command = str(tunnel_config.get('command') or 'tunnel-client')
    executable = resolve_executable(command)
    if not executable:
        raise RuntimeError(f'OpenAI tunnel command not found: {command}')
    profile = str(tunnel_config.get('profile') or 'local-gpt')
    print('Starting OpenAI Secure MCP Tunnel', flush=True)
    print(f'OpenAI tunnel command: {executable}', flush=True)
    print(f'OpenAI tunnel profile: {profile}', flush=True)
    print(f'Tunnel target: {gateway_base_url}/mcp', flush=True)
    return subprocess.Popen([executable, 'run', '--profile', profile], cwd=ROOT, env=env)


def stop_process(process: subprocess.Popen | None, name: str) -> None:
    if process is None or process.poll() is not None:
        return
    print(f'Stopping {name}...', flush=True)
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the local Agent MCP Gateway.")
    parser.add_argument("--repo", default=None, help="Trusted repo root. Defaults to REPO_ROOT from .env, then current directory.")
    parser.add_argument("--ip", default=None, help="Bind IP/host. Defaults to MCP_GATEWAY_HOST, then 127.0.0.1.")
    parser.add_argument("--port", type=int, default=None, help="Bind port. Defaults to MCP_GATEWAY_PORT, then 8101.")
    parser.add_argument("--advertise-url", default=None, help="Public HTTPS base URL to advertise in OAuth metadata when one is provided outside this repo.")
    parser.add_argument("--tunnel", action="store_true", help="Start OpenAI Secure MCP Tunnel using the [openai_tunnel] config profile.")
    parser.add_argument("--token", default=None, help="OAuth password and Bearer token. Defaults to env token/password or a generated token.")
    parser.add_argument("--no-install", action="store_true", help="Do not run npm install when node_modules is missing.")
    args = parser.parse_args()

    if shutil.which("node") is None or shutil.which("npm") is None:
        print("Node.js LTS with npm is required.", file=sys.stderr)
        return 1

    env = dict(os.environ)
    env.update({key: value for key, value in load_dotenv(ROOT / ".env").items() if value})
    tunnel_config = load_openai_tunnel_config(env)
    if args.tunnel:
        tunnel_config["enabled"] = True

    repo_root = Path(args.repo or os.getcwd()).expanduser().resolve()
    if not repo_root.exists():
        print(f"Repo root does not exist: {repo_root}", file=sys.stderr)
        return 1

    bind_host = args.ip or env.get("MCP_GATEWAY_HOST") or "127.0.0.1"
    port = args.port or int(env.get("MCP_GATEWAY_PORT") or 8101)
    token_source = "generated"
    token = args.token
    if token:
        token_source = "command line"
    else:
        token = env.get("MCP_BEARER_TOKEN")
        if token:
            token_source = "MCP_BEARER_TOKEN"
        else:
            token = env.get("MCP_AUTH_PASSWORD")
            if token:
                token_source = "MCP_AUTH_PASSWORD"
            else:
                token = secrets.token_urlsafe(24)
    advertise_url = args.advertise_url or env.get("MCP_ADVERTISE_URL") or ""
    advertised_host = env.get("MCP_ADVERTISE_HOST") or ("127.0.0.1" if bind_host == "0.0.0.0" else bind_host)
    advertised_base_url = advertise_url.rstrip("/") if advertise_url else f"http://{advertised_host}:{port}"
    gateway_base_url = local_gateway_base_url(bind_host, port)

    if not args.no_install and not (ROOT / "node_modules").exists():
        run(["npm", "install", "--no-fund", "--no-audit"])

    logs_dir = ROOT / "logs"
    logs_dir.mkdir(exist_ok=True)

    env.update(
        {
            "REPO_ROOT": str(repo_root),
            "MCP_GATEWAY_HOST": bind_host,
            "MCP_ADVERTISE_HOST": advertised_host,
            "MCP_ADVERTISE_URL": advertise_url,
            "MCP_GATEWAY_PORT": str(port),
            "MCP_AUTH_PASSWORD": token,
            "MCP_BEARER_TOKEN": token,
            "AUTH_STATE_PATH": str(logs_dir / "auth-state.json"),
            "FILESYSTEM_LOG_PATH": str(logs_dir / "filesystem-main.log"),
            "SHELL_LOG_PATH": str(logs_dir / "shell-main.log"),
        }
    )

    print(f"MCP endpoint: {advertised_base_url}/mcp", flush=True)
    print(f"Local gateway target: {gateway_base_url}/mcp", flush=True)
    print(f"OpenAI tunnel: {'enabled' if tunnel_config['enabled'] else 'disabled'}", flush=True)
    if token_source == "generated":
        print(f"Generated temporary bearer token: {token}", flush=True)
    else:
        print(f"Bearer token: configured via {token_source} (not printed)", flush=True)
    print(f"Trusted repo root: {repo_root}", flush=True)

    gateway_process: subprocess.Popen | None = None
    tunnel_process: subprocess.Popen | None = None
    try:
        gateway_process = subprocess.Popen(["node", str(ROOT / "scripts" / "authenticated-mcp-wrapper.mjs")], cwd=ROOT, env=env)
        if tunnel_config['enabled']:
            try:
                wait_for_gateway(gateway_base_url, gateway_process)
                tunnel_process = start_openai_tunnel(tunnel_config, env, gateway_base_url)
                time.sleep(0.75)
                if tunnel_process.poll() is not None:
                    raise RuntimeError(f"OpenAI tunnel exited immediately: code={tunnel_process.returncode}")
            except Exception as exc:  # noqa: BLE001 - tunnel is optional; local MCP must stay up.
                print(f"Warning: OpenAI tunnel unavailable; local MCP stays running: {exc}", file=sys.stderr, flush=True)
                tunnel_process = None
        return gateway_process.wait()
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 - CLI entrypoint should print actionable errors.
        print(f"Error: {exc}", file=sys.stderr, flush=True)
        return 1
    finally:
        stop_process(tunnel_process, "OpenAI tunnel")
        stop_process(gateway_process, "MCP gateway")


if __name__ == "__main__":
    raise SystemExit(main())
