# MCP Device SDK and Contract Boundary

## Public MCP boundary

The client-facing MCP server is the gateway. It uses the stable MCP TypeScript SDK v2 split packages at exact version 2.0.0 and targets the 2026-07-28 MCP specification.

The gateway owns the public execution-tool contract exposed to clients. The frozen machine-readable baseline is:

- `contracts/device-public-contract-v1.json`
- regenerate intentionally with `node scripts/check-device-public-contract.mjs --write`
- verify with `npm run contract:device:check`

The check classifies tool-surface changes as `unchanged`, `additive`, `deprecated`, or `breaking`, and exits non-zero for breaking changes.

## Gateway-to-device boundary

Gateway-to-device communication is not MCP. It is the authenticated device protocol with its own connection epoch, runtime readiness, execution-runtime generation, authorization checks, inner TLS, and no-replay semantics.

Do not pass MCP SDK classes or objects across this boundary.

## Device-local MCP boundary

The bundled execution engine inside `@hcu-lab.me/mcp-device` still uses `@modelcontextprotocol/sdk` v1 over local stdio. This is an internal implementation boundary between the device process and its bundled local execution child, not the public client-facing MCP surface.

For the 1.0.7 line this dependency is pinned to exact version 1.30.0 so the package can preserve its current Node.js >=18 runtime contract.

Do not mechanically run the v1-to-v2 codemod across the device package as part of a patch/minor release. MCP SDK v2 requires Node.js 20+ and uses split packages; moving this private local boundary to v2 therefore needs an explicit runtime-support decision and should be handled as a separate compatibility change.

## Release rule

Before changing any public execution tool name, required argument, schema constraint, output schema, annotations, or contract metadata:

1. change the canonical runtime definitions in `scripts/device-execution-tool-definitions.mjs`;
2. run `npm run contract:device:check`;
3. review the reported classification;
4. update the frozen fixture only when the contract change is intentional and release policy permits it.

Never edit the fixture merely to make a failing contract check green.
