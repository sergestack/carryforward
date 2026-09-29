/**
 * Canonical tool names and derived SessionSource type.
 * Adding a new tool: add the name here, then the compiler surfaces every location that needs updating.
 */
/** Ordered list of all supported tool names — single source of truth */
export const TOOL_NAMES = Object.freeze([
    'claude',
    'codex',
    'copilot',
    'gemini',
    'opencode',
    'droid',
    'cursor',
    'amp',
    'kiro',
    'crush',
    'cline',
    'roo-code',
    'kilo-code',
    'antigravity',
    'kimi',
    'qwen-code',
]);
export function isSessionSource(value) {
    return TOOL_NAMES.includes(value);
}
// ── Canonical Tool Name Sets ────────────────────────────────────────────────
// Used by all parsers to classify tool invocations consistently.
// Each set contains all known aliases for a tool category across every CLI.
/** Shell/command execution tools */
export const SHELL_TOOLS = new Set([
    'Bash',
    'bash',
    'terminal',
    'run_terminal_command',
    'run_shell_command',
    'Shell',
    'exec_command',
    'shell_command',
    'Execute',
]);
/** File read tools */
export const READ_TOOLS = new Set(['Read', 'ReadFile', 'read_file']);
/** File write/create tools */
export const WRITE_TOOLS = new Set([
    'Write',
    'WriteFile',
    'write_file',
    'Create',
    'create',
    'create_file',
]);
/** File edit/patch tools */
export const EDIT_TOOLS = new Set([
    'Edit',
    'EditFile',
    'edit_file',
    'edit',
    'apply_diff',
    'apply_patch',
    'ApplyPatch',
    'replace',
    'mcp__morph__edit_file',
    'morph___edit_file',
]);
/** Search/grep tools */
export const GREP_TOOLS = new Set([
    'Grep',
    'grep',
    'grep_search',
    'codebase_search',
    'search_file_content',
    'SearchFiles',
]);
/** Glob/directory listing tools */
export const GLOB_TOOLS = new Set([
    'Glob',
    'glob',
    'list_directory',
    'ListFiles',
    'file_search',
    'LS',
    'FindFiles',
    'ReadFolder',
]);
/** Web search tools */
export const SEARCH_TOOLS = new Set(['WebSearch', 'web_search', 'web_search_call']);
/** Web fetch tools */
export const FETCH_TOOLS = new Set(['WebFetch', 'web_fetch']);
/** Subagent/task tools */
export const TASK_TOOLS = new Set(['Task', 'task', 'Agent']);
/** Task output tools */
export const TASK_OUTPUT_TOOLS = new Set(['TaskOutput']);
/** User interaction tools */
export const ASK_TOOLS = new Set(['AskUserQuestion', 'request_user_input']);
/** Tools to skip — internal bookkeeping, no useful handoff context */
export const SKIP_TOOLS = new Set([
    'TaskStop',
    'TodoWrite',
    'todo_write',
    'SaveMemory',
    'save_memory',
    'Skill',
    'skill',
    'Lsp',
    'lsp',
    'update_plan',
    'view_image',
]);
/**
 * Classify a raw tool invocation name into a ToolSampleCategory.
 * Returns `undefined` for tools that should be skipped (internal bookkeeping).
 * Returns `'mcp'` for unrecognized / MCP-namespaced tools.
 */
export function classifyToolName(name) {
    if (SKIP_TOOLS.has(name))
        return undefined;
    if (SHELL_TOOLS.has(name))
        return 'shell';
    if (READ_TOOLS.has(name))
        return 'read';
    if (WRITE_TOOLS.has(name))
        return 'write';
    if (EDIT_TOOLS.has(name))
        return 'edit';
    if (GREP_TOOLS.has(name))
        return 'grep';
    if (GLOB_TOOLS.has(name))
        return 'glob';
    if (SEARCH_TOOLS.has(name))
        return 'search';
    if (FETCH_TOOLS.has(name))
        return 'fetch';
    if (TASK_TOOLS.has(name) || TASK_OUTPUT_TOOLS.has(name))
        return 'task';
    if (ASK_TOOLS.has(name))
        return 'ask';
    return 'mcp';
}
//# sourceMappingURL=tool-names.js.map