export function normalizeRemoteFilesystemResult(result) {
  if (!result || typeof result !== 'object' || result.structuredContent !== undefined) return result;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(item => item?.type === 'text')
    .map(item => String(item.text ?? ''))
    .join('\n');
  return { ...result, structuredContent: { content: text } };
}
