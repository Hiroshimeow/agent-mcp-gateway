const DYNAMIC_ROOT_META_KEYS = new Set(['trusted_roots', 'root_repo', 'repo_root']);

export const LOCAL_COLLISION_TOOL_NAMES = new Set([
  'read_text_file',
  'write_file',
  'edit_file',
  'shell_execute',
  'image_preview',
  'get_skill',
  'project_list',
  'project_inspect',
  'list_devices',
  'start_process',
  'read_process_output',
  'interact_with_process',
  'terminate_process'
]);

export function stableToolDefinition(tool = {}) {
  const meta = { ...(tool._meta || {}) };
  for (const key of DYNAMIC_ROOT_META_KEYS) delete meta[key];
  const stable = { ...tool };
  if (Object.keys(meta).length > 0) stable._meta = meta;
  else delete stable._meta;
  return stable;
}

export function workspaceCatalogChanges(change = {}, surfaceConfig = {}) {
  return {
    toolsChanged: false,
    resourcesChanged: Boolean(change.rootsChanged && surfaceConfig.enumerateProjectResources),
    promptsChanged: false
  };
}
