1|# Agent MCP Gateway
2|
3|README tiếng Việt tóm tắt cho cấu hình xác thực, trusted roots và flow live launcher.
4|
5|## Chạy hiện tại
6|
7|Shell tool dùng PowerShell trên Windows và POSIX shell trên Linux/macOS. Command được chạy nguyên văn theo shell đã chọn; gateway không tự dịch cú pháp giữa PowerShell và POSIX.
8|
9|Entrypoint nhanh nhất là:
10|
11|```powershell
12|uv run main.py
13|```
14|
15|Nếu không truyền tham số, lệnh này dùng:
16|
17|```text
18|repo root: thư mục hiện tại
19|bind IP:   127.0.0.1
20|port:      8101
21|MCP URL:   http://127.0.0.1:8101/mcp
22|```
23|
24|Muốn chọn repo/IP/port:
25|
26|```powershell
27|uv run main.py --repo E:\path\to\project --ip 127.0.0.1 --port 8101
28|```
29|
30|`--ip` có thể là IP Tailscale, `0.0.0.0`, hoặc `127.0.0.1`.
31|
32|Khi expose qua domain HTTPS/reverse proxy/SSH tunnel, gateway tự derive OAuth metadata từ `Host`/`X-Forwarded-*` headers. Nếu proxy không giữ các header này, set public base URL thủ công:
33|
34|```powershell
35|uv run main.py --ip 127.0.0.1 --port 8101 --advertise-url https://mcp.hcu-lab.me
36|```
37|
38|Mục tiêu là metadata trả về `https://mcp.hcu-lab.me/register`, không phải loopback local mà ChatGPT không gọi được.
39|
40|Entrypoint có prompt trên Windows là:
41|
42|```powershell
43|.\start-mcp-live.bat
44|```
45|
46|Dừng phiên đang chạy bằng:
47|
48|```powershell
49|.\stop-mcp-live.bat
50|```
51|
52|Flow `start-mcp-stack.bat` và các script `start/stop-mcp-stack.ps1` đã bị loại bỏ. `start-mcp-live.bat` là launcher được khuyến nghị.
53|
54|`.env` dùng cho token, trusted roots và cấu hình nâng cao. Riêng `uv run main.py` không lấy `REPO_ROOT`, `MCP_GATEWAY_HOST`, `MCP_GATEWAY_PORT` từ `.env` làm default; muốn đổi thì truyền `--repo`, `--ip`, `--port`.
55|
56|Quy tắc log token:
57|
58|- Token lấy từ `.env`, biến môi trường, hoặc `--token` sẽ không bị in ra console.
59|- Nếu chưa cấu hình token, `uv run main.py` sẽ sinh token tạm thời cho phiên hiện tại và in ra một lần để bạn đăng nhập.
60|- Token tạm thời vẫn là secret; tắt server để hủy giá trị runtime này.
61|
62|## Xác thực
63|
64|Launcher luôn giữ OAuth làm cơ chế xác thực chính cho ChatGPT Developer Mode. OAuth vẫn giữ nguyên cho ChatGPT.
65|
66|Ngoài OAuth, launcher hỗ trợ tuỳ chọn static Bearer token cho các MCP client khác như Hermes/OpenClaw khi client không dùng OAuth được.
67|
68|Ví dụ header:
69|
70|```text
71|Authorization: Bearer ***
72|```
73|
74|Cấu hình token qua biến môi trường:
75|
76|```dotenv
77|MCP_BEARER_TOKEN=
78|```
79|
80|Nếu `MCP_BEARER_TOKEN` trống, launcher chỉ chấp nhận OAuth như trước.
81|
82|## Trusted roots và project discovery
83|
84|`config/trusted-roots.txt` là nguồn cấu hình chính cho trusted roots và multi-project discovery trong v1. Không dùng `config/projects.json`.
85|
86|Các format được hỗ trợ:
87|
88|```text
89|path
90|path | projectId
91|path | projectId | displayName
92|```
93|
94|Có thể lặp lại cùng một `projectId` trên nhiều dòng để gom nhiều root vào cùng một project. Dòng legacy chỉ có path vẫn hoạt động và sẽ được sinh project id ổn định.
95|
96|Agent nên gọi `custom_list_projects` để discover `projectId`. Mặc định tool này chỉ trả về `projectId` và `displayName`, không expose full local paths. Nếu thật sự cần expose path, đặt:
97|
98|```dotenv
99|MCP_EXPOSE_PROJECT_PATHS=true
100|```
101|
102|rồi gọi `custom_list_projects` với `showPaths: true`.
103|
104|## Lưu ý isolation
105|
106|`projectId` hiện là routing metadata cho workflow multi-agent. Đây chưa phải hard sandbox isolation: filesystem và shell tools vẫn hoạt động trên global trusted roots đã cấu hình.
107|