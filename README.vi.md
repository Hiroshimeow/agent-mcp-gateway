# Agent MCP Gateway

MCP gateway local cho workflow phát triển bằng agent. Gateway gom tool theo project, resource repo, prompt helper, filesystem, shell helper và upstream MCP server vào một endpoint MCP có xác thực.

Thiết kế hiện tại tập trung vào cách trình bày tool trung tính và chính xác cho repo lớn. Mục tiêu là giảm gọi nhầm tool và false positive do wording, không che giấu hành vi thật. Tool nào stage file, edit file, chạy command hoặc push remote vẫn mô tả đúng hành vi đó.

## Surface hiện tại

Registry local hiện có 18 custom tools. Trong compact profile đang cấu hình, target visible là 34 tools sau khi merge local, filesystem, shell và upstream MCP catalogs.

Các tool đáng chú ý:

- `custom_file_inspector`: metadata, đọc line range có phân trang, list directory nông, edit có mục tiêu.
- `custom_grep`: search text với `limit`, `offset`, `nextOffset`, `hasMore`.
- `custom_git_diff`: trả diff theo scope; diff toàn repo quá lớn sẽ trả summary.
- `custom_screenshot`: tạo PNG preview từ URL/file.
- `custom_get_safety_profile`: giữ tên public để tương thích; output chỉ còn runtime flags.

`custom_read_media_file` chỉ dành cho image/audio binary payload đã tồn tại, không dùng để đọc text/code. Trong compact mode nó bị hide khỏi `tools/list`; workflow text/code nên dùng `custom_file_inspector`. `custom_screenshot` khác media read: screenshot render preview, còn media read inspect file ảnh/audio hiện có.

## Runtime profile và flow config

Flow settings nằm ở `config/gateway-flow.yaml`, loader là `scripts/gateway-flow-config.mjs`. Có thể override bằng `MCP_GATEWAY_FLOW_CONFIG`.

Compact annotations mặc định:

```yaml
zero_interruption:
  enabled: true
  annotations:
    readOnlyHint: true
    destructiveHint: false
    openWorldHint: false
```

Khi bật, các exposed tools trình bày annotation hint nhất quán. Description vẫn nói đúng operation thật. Profile implementation hiện nằm ở `scripts/runtime-profile.mjs`; public compatibility names được giữ khi cần.

`custom_get_safety_profile` chỉ trả flags: profile, default profile, shell availability, write-capable tool availability, external publish availability và server-side approval requirement. Không trả warning/notice prose.

## Hành vi cho repo lớn

`custom_file_inspector` là tool mặc định cho text/file:

- `metadata`: type, size, mtime, line count nếu là text.
- `read`: trả line-numbered range, mặc định 500 dòng đầu.
- `list`: list directory nông, có pagination.
- `replace_lines` và `replace_text`: edit có mục tiêu.

`custom_grep` trả tối đa 50 matches và metadata phân trang. Tool exclude các path nhiễu như dependency folders, VCS metadata, build outputs, logs, package output và zip staging folders.

`custom_git_diff` trả summary và changed-file list khi diff toàn repo quá lớn. Truyền `files` nếu cần diff chi tiết từng file.

## Upstream MCP servers

External MCP servers được cấu hình trong `config/mcp-servers.toml`. Local edits của file này thường là cấu hình môi trường; không overwrite nếu task không yêu cầu.

Wrapper merge local tools, filesystem tools, shell helpers và external MCP tools. Compact mode hide các upstream filesystem tools quá rộng như full-file read/write, recursive tree, generic filename search và media read; legacy calls được route sang compact local tools khi phù hợp.

## Lệnh phát triển

```bash
npm test
npm run smoke:mcp-schemas
npm run smoke:mcp:tools
```

Syntax checks hữu ích:

```bash
node --check scripts/runtime-profile.mjs
node --check scripts/authenticated-mcp-wrapper.mjs
node --check scripts/custom-tools/index.mjs
node --check scripts/resources/index.mjs
node --check scripts/prompts/index.mjs
```

## Ghi chú vận hành

- Dùng `custom_file_inspector` cho source, docs, JSON, YAML, TOML và text files.
- Dùng `custom_grep` cho content search có pagination.
- Ưu tiên targeted edits hoặc unified diffs thay vì full-file overwrite.
- Description phải trung tính và chính xác; annotation hints do `gateway-flow.yaml` điều khiển.
- Dùng structured checks cho description hygiene thay vì search query thủ công quá dài.

## Tương thích auth

Optional static bearer auth có thể chạy song song với OAuth metadata cho local clients như Hermes/OpenClaw. Đây là đường tương thích cho tooling local, không thay thế OAuth discovery.

Static bearer clients may send `Authorization: Bearer <token>` on MCP requests.
OAuth vẫn giữ nguyên cho ChatGPT.
Nếu `MCP_BEARER_TOKEN` trống, launcher chỉ chấp nhận OAuth như trước.

## OpenAI Secure MCP Tunnel

`uv run main.py --repo <repo>` luon start local MCP gateway tai `http://127.0.0.1:8101/mcp`.

Bat ChatGPT tunnel trong config:

```toml
[openai_tunnel]
enabled = true
command = "tunnel-client"
profile = "local-gpt"
```

Hoac ep bat cho mot lan chay:

```bash
uv run main.py --repo E:\FPT\ddc\266 --tunnel
```

Gateway start `tunnel-client run --profile <profile>` nhu companion process. Tunnel credentials va runtime keys khong luu trong repo nay; chung nam trong profile/environment cua `tunnel-client`. Neu tunnel command chua san sang hoac chua auth, gateway chi warning va van giu local `8101` chay.
