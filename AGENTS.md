# Repository agent contract

- `scripts/skills/` is the only global/team runtime skill source; repo-local skills belong under `.agents/skills/`.
- Runtime skills come from one disk-backed registry. Do not hard-code built-in skills or add a server-side classifier/router.
- Standard-capable clients use the MCP Skills extension; generic clients use only `skill_catalog` and `load_skill`.
- `mcp-device` is the execution plane only. Keep skill registry, discovery, and routing semantics out of device code.
- Preserve unrelated dirty work. Do not reset, clean, or stash a user's working tree to implement a change.
- For MCP/skill changes run: `npm test`, `npm run skills:check`, `npm run skills:sync`, `npm test`, `npm run smoke:mcp-schemas`, `npm run smoke:mcp:tools`, and the full MCP live smoke plus relevant auth/device regressions.
