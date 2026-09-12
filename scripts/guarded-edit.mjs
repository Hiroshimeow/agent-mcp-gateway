import { truncateText } from './custom-tools/response-utils.mjs';

export const GUARDED_EDIT_PREVIEW_BYTES = 8192;

export function countExactOccurrences(content, oldText) {
  if (!oldText) throw new Error('old_text must be a non-empty string');
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(oldText, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + oldText.length;
  }
}

function replaceAllExact(content, oldText, newText) {
  return content.split(oldText).join(newText);
}

function previewAroundFirstChange(content, oldText, newText) {
  const index = content.indexOf(oldText);
  if (index < 0) return { text: '', truncated: false };
  const context = 1024;
  const start = Math.max(0, index - context);
  const end = Math.min(content.length, index + oldText.length + context);
  const before = content.slice(start, end);
  const after = before.replace(oldText, newText);
  return truncateText(`before:\n${before}\n\nafter:\n${after}`, GUARDED_EDIT_PREVIEW_BYTES);
}

export function prepareGuardedEdit(content, { oldText, newText, expectedReplacements = 1 }) {
  if (typeof content !== 'string') throw new Error('file content must be text');
  if (typeof oldText !== 'string' || oldText.length === 0) throw new Error('old_text must be a non-empty string');
  if (typeof newText !== 'string') throw new Error('new_text must be a string');
  if (!Number.isInteger(expectedReplacements) || expectedReplacements < 1) {
    throw new Error('expected_replacements must be a positive integer');
  }

  const actualCount = countExactOccurrences(content, oldText);
  if (actualCount !== expectedReplacements) {
    return {
      ok: false,
      actualCount,
      expectedReplacements,
      modifiedContent: null,
      preview: null
    };
  }

  return {
    ok: true,
    actualCount,
    expectedReplacements,
    modifiedContent: replaceAllExact(content, oldText, newText),
    preview: previewAroundFirstChange(content, oldText, newText)
  };
}
