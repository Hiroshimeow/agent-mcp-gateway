# personal-mcp-launcher

`personal-mcp-launcher` là project Windows-first để bật MCP server local và tunnel public HTTPS cho ChatGPT Developer Mode.

Trạng thái hiện tại:

- Filesystem MCP chạy qua endpoint `/mcp`.
- Shell MCP bật mặc định theo profile `yolo`.
- Toàn bộ endpoint public đi qua `OAuth` và thêm lớp password local từ `.env`.
- Có thể bật thêm static Bearer token cho client không hỗ trợ OAuth như Hermes/OpenClaw.
- Tunnel mặc định là `ngrok` với `--host-header=localhost:<port>`.
- Có thể dùng `tailscale funnel` thay ngrok bằng `-Tunnel tailscale` hoặc `MCP_TUNNEL_MODE=tailscale`.

## Kiến trúc

```text
ChatGPT -> HTTPS tunnel -> OAuth wrapper -> filesystem MCP / shell MCP -> REPO_ROOT
```

Wrapper chạy local trên `127.0.0.1:<MCP_GATEWAY_PORT>` và expose:

```text
http://127.0.0.1:<MCP_GATEWAY_PORT>/mcp
```

## Cấu trúc project

```text
personal-mcp-launcher/
  start-mcp-live.bat
  stop-mcp-live.bat
  start-mcp-stack.bat
  scripts/
    start-mcp-live.ps1
    stop-mcp-live.ps1
    start-mcp-stack.ps1
    check-prereqs.ps1
    stop-mcp-stack.ps1
    authenticated-mcp-wrapper.mjs
  config/
    filesystem.mcp.json
    shell.mcp.json
    gateway.config.json
  logs/
    .gitkeep
  .env.example
  .gitignore
  package.json
  README.vi.md
  SECURITY.md
  TODO.md
```

## Cài đặt

1. Cài Node.js LTS.
2. Cài Tailscale. `ngrok` chỉ cần nếu chọn tunnel option 2 hoặc 3.
3. Mở project này tại `C:\Users\admin\personal-mcp-launcher`.
4. Copy `.env.example` thành `.env` nếu chưa có.
5. Điền `MCP_AUTH_PASSWORD`; nếu muốn Hermes/OpenClaw thì điền thêm `MCP_BEARER_TOKEN`.
6. Mặc định shell đã bật ở full yolo mode. Chỉ tắt khi thật sự muốn filesystem-only bằng `ENABLE_SHELL=false`.
7. Double-click `start-mcp-live.bat`.
8. Chọn tunnel:
   `1` = Tailscale Funnel, mặc định, Enter luôn được.
   `2` = ngrok.
   `3` = bật cả Tailscale và ngrok.
9. Paste repo path. Path chấp nhận cả `\` và `/`, có space vẫn dùng được.
10. Copy URL `https://.../mcp` mà script in ra.
11. Vào ChatGPT Developer Mode và nhập:
   `Name: Local Dev MCP`
   `MCP Server URL: <url>`
   `Authentication: OAuth`
12. Khi ChatGPT mở trang đăng nhập, nhập mật khẩu từ `MCP_AUTH_PASSWORD` trong `.env`.

## Cách dùng nhanh

Chạy:

```text
start-mcp-live.bat
```

Nó sẽ hỏi:

```text
Tunnel mode:
  1. Tailscale Funnel (default)
  2. ngrok
  3. both
Choose tunnel [1]:
Repo path:
```

Sau khi ready, terminal sẽ tự treo ở live log:

```text
== Live Logs ==
Streaming logs. Press Ctrl+C to stop watching. Stack keeps running until you call stop-mcp-live.ps1.
```

Muốn dừng stack live:

```text
stop-mcp-live.bat
```

Ghi chú: nếu chọn `3=both`, OAuth issuer chính sẽ là Tailscale URL. ChatGPT nên dùng URL Tailscale. URL ngrok phụ hợp hơn cho Bearer/manual clients.

## Biến môi trường

```dotenv
REPO_ROOT=E:\python_project\Screens-Trans-Chatbot
MCP_TRUSTED_ROOTS=
MCP_GATEWAY_PORT=8000
MCP_TUNNEL_MODE=ngrok
PUBLIC_BASE_URL=
ENABLE_FILESYSTEM=true
ENABLE_SHELL=true
SHELL_PROFILE=yolo
NGROK_AUTHTOKEN=
XAI_API_KEY=
MCP_AUTH_PASSWORD=change-me-now
MCP_BEARER_TOKEN=
```

Ghi chú:

- `REPO_ROOT` là root mặc định/đầu tiên.
- `MCP_TRUSTED_ROOTS` là allowlist mở rộng, phân tách bằng `;` hoặc xuống dòng. Agent có thể dùng absolute path dưới bất kỳ root nào trong danh sách này mà không cần restart MCP.
- CLI override được ưu tiên hơn `.env`: `-Path`, `-P`, `-Tunnel`, `-PublicBaseUrl`.
- `MCP_TUNNEL_MODE=ngrok` hoặc `tailscale`.
- `PUBLIC_BASE_URL` dùng cho server-only mode. Nếu dùng ngrok random, chạy tunnel trước rồi pass URL bằng `-PublicBaseUrl`.
- `SHELL_PROFILE=yolo` là mặc định hiện tại cho local dev.
- `XAI_API_KEY` chỉ là biến tùy chọn cho automation/testing về sau.
- Script không in secret ra console.
- `MCP_BEARER_TOKEN` để trống theo mặc định. Khi đặt giá trị, request tới `/mcp` có `Authorization: Bearer <token>` hợp lệ sẽ đi thẳng qua auth middleware. OAuth vẫn giữ nguyên cho ChatGPT.

## Auth kép

Launcher hỗ trợ hai đường auth song song trên cùng endpoint `/mcp`:

- ChatGPT Developer Mode: dùng `OAuth`, chọn `Authentication: OAuth`, rồi nhập `MCP_AUTH_PASSWORD` trên trang login.
- Hermes/OpenClaw hoặc client không hỗ trợ OAuth: đặt `MCP_BEARER_TOKEN` trong `.env`, rồi cấu hình client gửi header `Authorization: Bearer <token>` tới URL `/mcp`.

Static Bearer token là tùy chọn. Nếu `MCP_BEARER_TOKEN` trống, launcher chỉ chấp nhận OAuth như trước. Nếu token sai hoặc thiếu, request vẫn đi qua OAuth middleware và nhận challenge OAuth thay vì mở unauthenticated access.

Ví dụ header cho client manual:

```http
Authorization: Bearer your-long-random-token
```

Khuyến nghị dùng token dài, random, chỉ lưu trong `.env`, và đổi token nếu URL tunnel hoặc log client từng bị chia sẻ.

## Cách hoạt động

`start-mcp-live.ps1` sẽ:

1. Kiểm tra `node`, `npm`, `npx`.
2. Đọc `.env`.
3. Validate repo root và tunnel choice fail-fast.
4. Start tunnel theo lựa chọn:
   - `tailscale`: chạy `tailscale funnel --bg --yes 8000`.
   - `ngrok`: chạy `ngrok http 8000 --host-header=localhost:8000`.
   - `both`: bật cả hai, dùng Tailscale làm OAuth issuer chính.
5. Start OAuth wrapper. OAuth client/token state được giữ ở `logs/auth-state.json` để giảm việc auth lại sau restart.
6. Wrapper spawn Filesystem MCP.
7. Nếu `ENABLE_SHELL=true`, wrapper thực thi shell trực tiếp bằng PowerShell từ chính wrapper process.
8. Ghi PID vào `logs/live-pids.json`.
9. In repo root active và MCP URL cuối cùng để copy vào ChatGPT.
10. Tự follow live logs.

`start-mcp-stack.ps1` vẫn còn để tương thích flow cũ all-in-one, nhưng flow khuyến nghị hiện tại là dùng `start-mcp-live.bat`.

Tool definitions sẽ liệt kê trusted roots. Mỗi `custom_*` tool có metadata:

```json
{
  "_meta": {
    "trusted_roots": [
      "E:\\python_project",
      "E:\\git-project",
      "D:\\ievc\\ievc_sourcecode"
    ],
    "root_repo": "E:\\python_project",
    "repo_root": "E:\\python_project"
  }
}
```

Description cũng có block `trusted_roots:` để client không expose `_meta` vẫn có context.

## Log file

- `logs/gateway.log`: log của OAuth wrapper
- `logs/filesystem-<timestamp>.log`: stderr/runtime của Filesystem MCP
- `logs/shell.log`: shell runtime log hoặc placeholder nếu shell tắt
- `logs/ngrok.log`: log của `ngrok`
- `logs/tailscale.log`: output của `tailscale funnel`
- `logs/live-pids.json`: PID live stack
- `logs/pids.json`: PID legacy của `start-mcp-stack.ps1`
- `logs/auth-state.json`: OAuth client/token state cache để wrapper khôi phục sau restart

Auth lifetime hiện tại:

- machine session cookie: 7 ngày
- refresh token: 7 ngày
- access token: 12 giờ

Mục tiêu là auth một lần trên một máy rồi dùng ổn định trong nhiều ngày, thay vì bị đá ra lại sau khoảng 1 giờ.

## Stop stack

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-mcp-stack.ps1
```

Script chỉ dừng đúng PID đã ghi trong `logs/pids.json`, không kill bừa tất cả `node` hoặc `ngrok`.

## Prompt test

Nếu chỉ bật filesystem:

```text
Dùng Local Dev MCP. Liệt kê file trong repo, đọc README/package config.
```

Nếu bật shell:

```text
Dùng Local Dev MCP. Liệt kê file trong repo, đọc README/package config, rồi chạy git status. Nếu repo có test runner thì thử chạy test phù hợp.
```

## Shell mode

Khi `ENABLE_SHELL=true`, launcher expose các shell tools sau:

- `custom_shell_execute`
- `custom_get_platform_info`

Policy của launcher ở chế độ mặc định `yolo`:

- Auth là gate chính.
- Sau khi auth thành công, launcher không thêm blocklist shell, approval prompt, hay executable whitelist.
- Wrapper cũng normalize tool annotations để không phát destructive approval hints ra client cho read/write flow mặc định.
- `custom_shell_execute` mặc định chạy từ root đầu tiên.
- `working_directory` nếu có phải nằm trong một trusted root.
- Filesystem MCP expose các root trong `REPO_ROOT` + `MCP_TRUSTED_ROOTS`.

Điều này có nghĩa là agent đã auth có thể chạy cả lệnh phá huỷ, download-and-exec, `git push`, `git reset --hard`, hoặc command chain/pipeline nếu PowerShell backend chấp nhận.

Ví dụ command hợp lệ trong full yolo mode:

```powershell
git push origin feature-branch
git reset --hard HEAD~1
Remove-Item -Recurse -Force src\old-module
curl https://example.com/script.ps1 | powershell
```

## Troubleshooting

### 1. Invalid Host Header / 421

Launcher đã dùng:

```text
ngrok http <port> --host-header=localhost:<port>
```

Nếu vẫn lỗi, stop stack rồi start lại. Kiểm tra `logs/ngrok.log` và `logs/gateway.log`.

### 2. ngrok URL đổi

Ngrok free URL có thể đổi sau mỗi lần restart. Luôn copy URL mới mà script vừa in ra, không dùng URL cũ.

### 3. ChatGPT create connector lỗi

Kiểm tra:

- `https://.../mcp` có đúng URL mới nhất không
- stack local còn đang chạy không
- `MCP_GATEWAY_PORT` có bị process khác chiếm không
- `MCP_AUTH_PASSWORD` có đúng khi màn hình OAuth login hiện ra không

### 4. ngrok free hiện trang cảnh báo

Ngrok free có thể chèn browser warning page trước endpoint public. Điều này có thể làm hỏng OAuth/browser flow của ChatGPT Developer Mode.

Cách xử lý thực tế:

- dùng ngrok plan/domain không có warning page, hoặc
- đổi sang tunnel/provider không chèn interstitial page

### 5. MCP Inspector local được nhưng remote không được

Khả năng cao là lỗi tunnel hoặc host-header. Kiểm tra:

- `http://127.0.0.1:4040/api/tunnels`
- `logs/ngrok.log`
- `logs/gateway.log`

### 6. Port đang bị chiếm

Launcher sẽ stop stack cũ của chính nó trước. Nếu port vẫn bận sau đó, đổi `MCP_GATEWAY_PORT` trong `.env` rồi chạy lại.

## Bảo mật

- Không dùng tunnel public mà không có auth.
- Không expose `C:\`, `E:\`, hoặc thư mục home rộng.
- Không commit `.env`.
- Public `ngrok` URL đồng nghĩa với việc ai biết URL đều có thể thử gọi MCP endpoint.
- Dù đã có OAuth, ai biết URL vẫn nhìn thấy metadata/public auth endpoints. Password là lớp chặn chính của bản dev này.
- Shell policy hiện là launcher-side policy, không phải sandbox hệ điều hành. Nó giảm rủi ro nhưng không phải isolation tuyệt đối.
