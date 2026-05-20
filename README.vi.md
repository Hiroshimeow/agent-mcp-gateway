# Agent MCP Gateway

README tiếng Việt tóm tắt cho cấu hình xác thực, trusted roots và flow live launcher.

## Chạy hiện tại

Entrypoint nhanh nhất là:

```powershell
uv run main.py
```

Nếu không truyền tham số, lệnh này dùng:

```text
repo root: thư mục hiện tại
bind IP:   127.0.0.1
port:      8101
MCP URL:   http://127.0.0.1:8101/mcp
```

Muốn chọn repo/IP/port:

```powershell
uv run main.py --repo E:\path\to\project --ip 127.0.0.1 --port 8101
```

`--ip` có thể là IP Tailscale, `0.0.0.0`, hoặc `127.0.0.1`.

Nếu expose qua domain HTTPS/reverse proxy/SSH tunnel, vẫn bind local nhưng phải advertise URL public cho OAuth metadata:

```powershell
uv run main.py --ip 127.0.0.1 --port 8101 --advertise-url https://mcp.hcu-lab.me
```

Nếu không set, metadata có thể trả về `http://127.0.0.1:8101/register`, khiến ChatGPT không hoàn tất Dynamic Client Registration.

Entrypoint có prompt trên Windows là:

```powershell
.\start-mcp-live.bat
```

Dừng phiên đang chạy bằng:

```powershell
.\stop-mcp-live.bat
```

Flow `start-mcp-stack.bat` và các script `start/stop-mcp-stack.ps1` đã bị loại bỏ. `start-mcp-live.bat` là launcher được khuyến nghị.

`.env` dùng cho token, trusted roots và cấu hình nâng cao. Riêng `uv run main.py` không lấy `REPO_ROOT`, `MCP_GATEWAY_HOST`, `MCP_GATEWAY_PORT` từ `.env` làm default; muốn đổi thì truyền `--repo`, `--ip`, `--port`.

## Xác thực

Launcher luôn giữ OAuth làm cơ chế xác thực chính cho ChatGPT Developer Mode. OAuth vẫn giữ nguyên cho ChatGPT.

Ngoài OAuth, launcher hỗ trợ tuỳ chọn static Bearer token cho các MCP client khác như Hermes/OpenClaw khi client không dùng OAuth được.

Ví dụ header:

```text
Authorization: Bearer <token>
```

Cấu hình token qua biến môi trường:

```dotenv
MCP_BEARER_TOKEN=
```

Nếu `MCP_BEARER_TOKEN` trống, launcher chỉ chấp nhận OAuth như trước.

## Trusted roots và project discovery

`config/trusted-roots.txt` là nguồn cấu hình chính cho trusted roots và multi-project discovery trong v1. Không dùng `config/projects.json`.

Các format được hỗ trợ:

```text
path
path | projectId
path | projectId | displayName
```

Có thể lặp lại cùng một `projectId` trên nhiều dòng để gom nhiều root vào cùng một project. Dòng legacy chỉ có path vẫn hoạt động và sẽ được sinh project id ổn định.

Agent nên gọi `custom_list_projects` để discover `projectId`. Mặc định tool này chỉ trả về `projectId` và `displayName`, không expose full local paths. Nếu thật sự cần expose path, đặt:

```dotenv
MCP_EXPOSE_PROJECT_PATHS=true
```

rồi gọi `custom_list_projects` với `showPaths: true`.

## Lưu ý isolation

`projectId` hiện là routing metadata cho workflow multi-agent. Đây chưa phải hard sandbox isolation: filesystem và shell tools vẫn hoạt động trên global trusted roots đã cấu hình.
