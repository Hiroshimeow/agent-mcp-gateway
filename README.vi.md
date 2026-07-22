# Local Coding MCP Gateway

MCP gateway có xác thực, dùng chung cho workspace coding local. Tên deployment và connector thuộc cấu hình host; source của repo không phụ thuộc máy cụ thể.

## Catalog core

Catalog local chỉ có đúng sáu tool:

- `read_text_file`
- `write_file`
- `edit_file`
- `shell_execute`
- `image_preview`
- `get_skill`

Dùng official filesystem cho nội dung file. Dùng `shell_execute` cho `rg`, Git, test, build, lint, package manager, archive và process. Các wrapper MCP chuyên biệt cho Git/search/review/release đã bị xóa thật, không chỉ ẩn bằng surface mode khác.

## Skills live

Copy một folder chuẩn `<name>/SKILL.md` vào `scripts/skills/`. Gateway tự nhận add/edit/remove mà không restart, phát prompt/resource list-changed notification, và trả catalog hiện tại gồm name, alias, description trong `get_skill()` qua field `skillCatalog`.

Lần gọi `read_text_file` hoặc `image_preview` đầu tiên của một caller đã xác thực sẽ nhận một advisory ngắn. Trước lần đầu gọi local `write_file`, `edit_file` hoặc `shell_execute`, gateway yêu cầu caller đó load thành công một `get_skill(...)`. Lần block đầu giải thích đầy đủ; các lần lặp chỉ trả `Call get_skill().`. Sau khi load skill thành công, đúng ba local tool này được mở trong mặc định bốn giờ (`MCP_SKILL_BOOTSTRAP_TTL_MS`). Tool đọc và external MCP tool nằm ngoài local bootstrap gate này.

`SKILL.md` cần YAML frontmatter có `name` và `description` đủ rõ để agent chọn. `user-invocable: false` sẽ ẩn skill khỏi MCP prompts; `disable-model-invocation: true` vẫn cho load rõ ràng nhưng loại khỏi auto-selection. Thay đổi lỗi sẽ giữ catalog hợp lệ gần nhất.

Ponytail, Superpowers và các Anthropic skill được phép phân phối được quản lý qua `scripts/skills/sources.json`; commit chính xác nằm trong `sources.lock.json`. Dùng `npm run skills:check` để phát hiện upstream đã đổi và `npm run skills:sync` để tải, validate rồi áp dụng manifest hiện tại. Sync giữ nguyên skill local không được quản lý và kiểm tra license, symlink, dung lượng file và font file. Các Anthropic document skill proprietary được loại trừ có chủ đích.

Loader và updater chỉ dùng Node filesystem/path APIs cùng path tương đối theo repo nên cùng layout chạy trên Linux và Windows. Chỉ cần restart gateway khi code loader thay đổi; add/edit/remove hoặc sync skill sau đó không cần restart. Xem `scripts/skills/README.md` để biết workflow update và chính sách license.

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

Codegraph và ripgrep là CLI workflow, không phải MCP upstream. Skill `local_coding` chỉ dùng Codegraph khi có executable và index `.codegraph` sẵn; nếu không sẽ fallback sang `rg` và `read_text_file`.

## Kết quả shell

`shell_execute` trả JSON có cấu trúc: command, working directory yêu cầu/thực tế, exit code, stdout, stderr, phân loại stderr, duration, timeout, truncation metadata, original byte counts, returned byte counts và encoding UTF-8. Với `rg`, exit code `1` nghĩa là không có match, không phải gateway failure.

Runtime profile vẫn là `safe`, `assisted`, `yolo`. `safe` ẩn file mutation và shell; `assisted` cho phép file write nhưng ẩn shell; `yolo` expose đủ sáu core tool.

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
