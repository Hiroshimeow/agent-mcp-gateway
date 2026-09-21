# Local Coding MCP Gateway

MCP gateway có xác thực, dùng chung cho workspace coding local. Deployment production chuẩn hiện tại là https://device.hcu-lab.me, còn runtime vẫn cho phép cấu hình host khác.

## Quick start trên production

Các link production hiện tại:

- Dashboard: https://device.hcu-lab.me/dashboard
- Pair device: https://device.hcu-lab.me/pair
- Help / hướng dẫn setup: https://device.hcu-lab.me/help

Cài MCP Device hiện tại bằng:

```bash
npm install -g @hcu-lab.me/mcp-device
```

Quick start card trên web cố ý lấy gateway origin và các link Dashboard/Pair/Help từ request hiện tại thay vì hard-code hostname production. Vì vậy preview, staging hoặc custom deployment vẫn tự sinh đúng link; README chỉ ghi host production chuẩn.

## Catalog core

Gateway expose các tool filesystem, shell/process, device/project và external MCP theo runtime profile. Hai tool skill fallback duy nhất là:

- `skill_catalog`
- `load_skill`

`skill_catalog` chỉ trả metadata gọn và version; `load_skill` tải body của một skill hoặc một resource đã nằm trong manifest. Không có router/classifier phía server và không có tool riêng cho từng skill.

Dùng `shell_execute` cho `rg`, Git, test, build, lint, package manager, archive và process. Các wrapper MCP chuyên biệt cho Git/search/review/release đã bị xóa thật, không chỉ ẩn bằng surface mode khác.

## Skills live

`scripts/skills/` là global/team skill source duy nhất. Copy một folder chuẩn `<name>/SKILL.md` vào đó; gateway tự nhận add/edit/remove ở lần đọc kế tiếp mà không cần restart.

Client MCP hiện đại dùng extension chuẩn `io.modelcontextprotocol/skills` trên protocol `2026-07-28` với `skills/list`, `skills/get` và `resources/read`. Client generic dùng đúng hai fallback tool `skill_catalog` và `load_skill`. Cả hai đường đều đọc cùng một SkillRegistry, cùng manifest, digest và revision.

`SKILL.md` cần YAML frontmatter dạng mapping, `name` phải khớp tên folder theo dạng kebab-case, `description` không rỗng và body không rỗng. Metadata runtime luôn lấy từ file `SKILL.md` thực tế; không có alias runtime, prompt mirror, bootstrap advisory hay builtin fallback.

Ponytail, Superpowers và các Anthropic skill được phép phân phối được quản lý qua `scripts/skills/sources.json`; commit chính xác và compatibility patch nằm trong `sources.lock.json`. Dùng `npm run skills:check` để kiểm tra upstream và `npm run skills:sync` để fetch, kiểm tra license, áp dụng patch rồi validate catalog. Provenance không nằm trong package skill được serve.

Repo-local instructions/skills vẫn tách riêng ở `AGENTS.md` và `.agents/skills/`; chúng không được nhập vào global registry. Chỉ cần restart gateway khi code server thay đổi; add/edit/remove hoặc sync skill sau đó không cần restart. Xem `scripts/skills/README.md` để biết workflow update và chính sách license.

## Workspace roots live

`config/mcp-servers.toml` là file cấu hình duy nhất cho metadata server, trusted roots, optional upstream và tunnel.

Khi structured tool call chứa absolute path để thực hiện yêu cầu của user, gateway sẽ:

1. normalize path và lấy directory root nhỏ nhất phù hợp;
2. thêm root vào `[trusted_roots].roots` bằng lock và atomic replace;
3. reload một workspace registry dùng chung;
4. gửi `notifications/roots/list_changed` cho official filesystem;
5. chờ đến khi chính xác tập roots mới active;
6. tiếp tục tool call ban đầu, không restart và không hỏi lại quyền path.

Sửa TOML hợp lệ bằng tay sẽ hot-reload. TOML lỗi giữ nguyên runtime state hợp lệ gần nhất. Root được giữ đến khi bị xóa rõ ràng.

`[trusted_roots].roots` là nguồn cấp quyền duy nhất. `MCP_TRUSTED_ROOTS`, `MCP_IMAGE_PREVIEW_ROOTS` và các thư mục home mặc định không tự cấp quyền. Root cũ trong environment phải được chuyển vào array TOML. `image_preview`, filesystem, working directory của shell, resources và project discovery đều dùng cùng live root set và cùng chính sách canonical path. Lock có metadata owner; owner đã chết hoặc lock vượt ngưỡng stale bảo thủ 10 phút có thể được thu hồi.

## Optional upstreams

Context7, DeepWiki, Exa và ESLint mặc định `enabled = false`. Khi bật, gateway stage client và catalog ứng viên, rồi mới atomic commit và phát list-changed notification. Disable hoặc thay cấu hình server cũng là transaction: nếu startup hoặc catalog discovery của ứng viên lỗi, client, route, status và generation cũ vẫn hoạt động.

Codegraph và ripgrep là CLI workflow, không phải MCP upstream. Gateway không có skill đặc biệt cho các công cụ này; dùng `shell_execute`, `rg` và `read_text_file` khi phù hợp.

## Kết quả shell

`shell_execute` giữ model-facing result gọn: working directory thực tế, exit code, stdout, stderr, phân loại stderr, duration, timeout, trạng thái truncation và spill path. Original byte count chỉ xuất hiện cho stream bị truncate để agent biết kích thước dữ liệu cần recover; command echo, requested cwd, fixed encoding và các head/tail/returned-byte counter không còn lặp lại trong mỗi response. Full output quá lớn vẫn được spill ra file và có thể đọc lại. Với `rg`, exit code `1` nghĩa là không có match, không phải gateway failure.

Runtime profile vẫn là `safe`, `assisted`, `yolo`. `safe` ẩn file mutation và shell; `assisted` cho phép file write nhưng ẩn shell; `yolo` expose đầy đủ các tool execution được cấu hình. Hai fallback skill tool là read-only và không thay đổi theo profile.

Tài liệu tối ưu harness ngày 2026-09-09 được giữ làm lịch sử. Với skill architecture hiện tại, dùng `AGENTS.md`, README này và `scripts/skills/README.md` làm nguồn vận hành; không khôi phục loader/bootstrap cũ từ các plan lịch sử.

## Phát triển

```bash
npm test
npm run skills:check
npm run smoke:mcp-schemas
npm run smoke:mcp:tools
npm run smoke:mcp:upstreams
```

Check chính:

```bash
node --check scripts/authenticated-mcp-wrapper.mjs
node --check scripts/workspace-registry.mjs
node --check scripts/upstreams/manager.mjs
git diff --check
```

## Auth và tunnel

OAuth vẫn là đường chính cho ChatGPT. Static bearer auth có thể bật thêm cho local client nhưng không thay OAuth discovery.

`uv run main.py --repo <repo>` mở endpoint local tại `http://127.0.0.1:8101/mcp`. Tunnel được cấu hình trong `[openai_tunnel]`; credential nằm trong tunnel profile/environment, không lưu trong repo.
