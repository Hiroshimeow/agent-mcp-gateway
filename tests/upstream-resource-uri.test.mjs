import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExternalResourceUri, toExternalResourceUri } from '../scripts/upstreams/resource-uri.mjs';

test('wraps and unwraps upstream resource URIs', () => {
  const upstream = 'file:///tmp/a b.txt?x=1#frag';
  const uri = toExternalResourceUri('fake', upstream);
  assert.match(uri, /^external-mcp:\/\/fake\//);
  assert.deepEqual(parseExternalResourceUri(uri), { diagnostics: false, serverId: 'fake', upstreamUri: upstream });
});

test('parses diagnostics resources', () => {
  assert.equal(parseExternalResourceUri('external-mcp://_diagnostics/status').diagnostics, true);
  assert.equal(parseExternalResourceUri('external-mcp://fake/status').serverId, 'fake');
});
