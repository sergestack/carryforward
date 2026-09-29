/**
 * Shared tool extraction for parsers using Anthropic-style content blocks
 * (tool_use / tool_result). Used by Claude, Droid, and Cursor parsers.
 */
import { getPreset } from '../config/index.js';
import { ASK_TOOLS, EDIT_TOOLS, FETCH_TOOLS, GLOB_TOOLS, GREP_TOOLS, READ_TOOLS, SEARCH_TOOLS, SHELL_TOOLS, SKIP_TOOLS, TASK_OUTPUT_TOOLS, TASK_TOOLS, WRITE_TOOLS, } from '../types/tool-names.js';
import { countDiffStats, extractStdoutTail, formatEditDiff, formatNewFileDiff } from './diff.js';
import { extractExitCode, fetchSummary, fileSummary, globSummary, grepSummary, mcpSummary, SummaryCollector, searchSummary, shellSummary, subagentSummary, truncate, withResult, } from './tool-summarizer.js';
/**
 * Extract tool usage summaries and files modified from Anthropic-style messages.
 *
 * Works with any parser that uses tool_use / tool_result content blocks:
 * Claude, Droid, and Cursor all share this pattern.
 *
 * Two-pass approach:
 * 1. Collect all tool_result outputs by tool_use_id (with generous char limits)
 * 2. Process tool_use blocks with matched results, constructing structured data
 */
export function extractAnthropicToolData(messages, config = getPreset('standard')) {
    const collector = new SummaryCollector(config);
    const toolResultMap = new Map();
    // Generous first-pass limit — category-specific limits are applied in the second pass
    const firstPassMaxChars = Math.max(config.shell.maxChars, config.write.maxChars, config.edit.maxChars, config.mcp.resultChars, config.task.subagentResultChars, config.mcp.thinkingTools.maxReasoningChars);
    // First pass: collect all tool_result blocks (generous limits for rich extraction)
    for (const msg of messages) {
        if (!Array.isArray(msg.content))
            continue;
        for (const item of msg.content) {
            if (item.type !== 'tool_result')
                continue;
            const tr = item;
            if (!tr.tool_use_id)
                continue;
            let text = '';
            if (typeof tr.content === 'string') {
                text = tr.content;
            }
            else if (Array.isArray(tr.content)) {
                text = tr.content.find((c) => c.type === 'text')?.text || '';
            }
            if (text) {
                toolResultMap.set(tr.tool_use_id, {
                    text: text.slice(0, firstPassMaxChars),
                    isError: tr.is_error === true,
                });
            }
        }
    }
    // Second pass: process tool_use blocks with structured data extraction
    for (const msg of messages) {
        if (!Array.isArray(msg.content))
            continue;
        for (const item of msg.content) {
            if (item.type !== 'tool_use')
                continue;
            const tu = item;
            const name = tu.name;
            if (!name || SKIP_TOOLS.has(name))
                continue;
            const input = tu.input || {};
            const entry = tu.id ? toolResultMap.get(tu.id) : undefined;
            const result = entry?.text;
            const isError = entry?.isError ?? false;
            const fp = getInputString(input, 'file_path') || getInputString(input, 'path');
            if (SHELL_TOOLS.has(name)) {
                const cmd = input.command || input.cmd || '';
                const exitCode = extractExitCode(result);
                const errored = isError || (exitCode !== undefined && exitCode !== 0);
                const stdoutTail = result ? extractStdoutTail(result, config.shell.stdoutLines) : undefined;
                const errorMessage = errored && result ? result.slice(0, config.shell.maxChars) : undefined;
                const data = {
                    category: 'shell',
                    command: cmd,
                    ...(exitCode !== undefined ? { exitCode } : {}),
                    ...(stdoutTail ? { stdoutTail } : {}),
                    ...(errored ? { errored } : {}),
                    ...(errorMessage ? { errorMessage } : {}),
                };
                collector.add('Bash', shellSummary(cmd, result), { data, isError: errored });
            }
            else if (READ_TOOLS.has(name)) {
                const lineStart = input.offset || input.start_line || undefined;
                const lineEnd = input.limit
                    ? (lineStart || 1) + input.limit - 1
                    : input.end_line || undefined;
                const data = {
                    category: 'read',
                    filePath: fp,
                    ...(lineStart ? { lineStart } : {}),
                    ...(lineEnd ? { lineEnd } : {}),
                };
                collector.add(name, withResult(fileSummary('read', fp), result?.slice(0, 80)), {
                    data,
                    filePath: fp,
                });
            }
            else if (WRITE_TOOLS.has(name)) {
                const content = getInputString(input, 'content') || getInputString(input, 'file_text');
                let diff;
                let diffStats;
                // Derive isNewFile from context: tool name hints, result text, or leave undefined
                const isNewFile = ['Create', 'create', 'create_file'].includes(name)
                    ? true
                    : result && /\b(created|new file|overwr)/i.test(result)
                        ? /\b(created|new file)\b/i.test(result)
                        : undefined;
                if (content) {
                    const diffResult = formatNewFileDiff(content, fp, 200);
                    diff = diffResult.diff;
                    diffStats = countDiffStats(diff);
                }
                const writeErrorMsg = isError && result ? result.slice(0, config.write.maxChars) : undefined;
                const data = {
                    category: 'write',
                    filePath: fp,
                    ...(isNewFile !== undefined ? { isNewFile } : {}),
                    ...(diff ? { diff } : {}),
                    ...(diffStats ? { diffStats } : {}),
                    ...(writeErrorMsg ? { errorMessage: writeErrorMsg } : {}),
                };
                collector.add(name, withResult(fileSummary('write', fp, diffStats, isNewFile ?? false), result?.slice(0, 80)), {
                    data,
                    filePath: fp,
                    isWrite: true,
                    isError,
                });
            }
            else if (EDIT_TOOLS.has(name)) {
                const oldStr = getInputString(input, 'old_string') || getInputString(input, 'old_str');
                const newStr = getInputString(input, 'new_string') || getInputString(input, 'new_str');
                const patchText = getInputString(input, 'input') || getInputString(input, 'patch') || getInputString(input, 'content');
                const patchFiles = patchText ? extractPatchFilePaths(patchText) : [];
                const targetPath = fp || patchFiles[0] || '';
                let diff;
                let diffStats;
                if (oldStr || newStr) {
                    const diffResult = formatEditDiff(oldStr, newStr, targetPath, 200);
                    diff = diffResult.diff;
                    diffStats = countDiffStats(diff);
                }
                else if (patchText && patchFiles.length > 0) {
                    diff = truncate(patchText, config.edit.maxChars);
                    diffStats = countDiffStats(diff);
                }
                const editErrorMsg = isError && result ? result.slice(0, config.edit.maxChars) : undefined;
                const data = {
                    category: 'edit',
                    filePath: targetPath,
                    ...(diff ? { diff } : {}),
                    ...(diffStats ? { diffStats } : {}),
                    ...(editErrorMsg ? { errorMessage: editErrorMsg } : {}),
                };
                collector.add(name, withResult(fileSummary('edit', targetPath, diffStats), result?.slice(0, 80)), {
                    data,
                    filePath: targetPath,
                    isWrite: true,
                    isError,
                });
                for (const patchFile of patchFiles)
                    collector.trackFile(patchFile);
            }
            else if (GREP_TOOLS.has(name)) {
                const pattern = input.pattern || input.query || '';
                const targetPath = input.path || '';
                // Try to parse match count from result (e.g. "Found 5 files" or line count)
                const matchCount = result ? parseMatchCount(result) : undefined;
                const data = {
                    category: 'grep',
                    pattern,
                    ...(targetPath ? { targetPath } : {}),
                    ...(matchCount !== undefined ? { matchCount } : {}),
                };
                collector.add('Grep', withResult(grepSummary(pattern, targetPath), result?.slice(0, 80)), { data });
            }
            else if (GLOB_TOOLS.has(name)) {
                const pattern = input.pattern || input.path || '';
                const resultCount = result ? parseFileCount(result) : undefined;
                const data = {
                    category: 'glob',
                    pattern,
                    ...(resultCount !== undefined ? { resultCount } : {}),
                };
                collector.add('Glob', withResult(globSummary(pattern), result?.slice(0, 80)), { data });
            }
            else if (FETCH_TOOLS.has(name)) {
                const url = input.url || '';
                const data = {
                    category: 'fetch',
                    url,
                    ...(result ? { resultPreview: result.slice(0, 100) } : {}),
                };
                collector.add('WebFetch', fetchSummary(url), { data });
            }
            else if (SEARCH_TOOLS.has(name)) {
                const query = input.query || '';
                const resultCount = result ? parseMatchCount(result) : undefined;
                const resultPreview = result ? result.slice(0, 100) : undefined;
                const data = {
                    category: 'search',
                    query,
                    ...(resultCount !== undefined ? { resultCount } : {}),
                    ...(resultPreview ? { resultPreview } : {}),
                };
                collector.add('WebSearch', searchSummary(query), { data });
            }
            else if (TASK_TOOLS.has(name)) {
                const description = input.description || '';
                const agentType = input.subagent_type || undefined;
                const data = {
                    category: 'task',
                    description,
                    ...(agentType ? { agentType } : {}),
                };
                collector.add('Task', subagentSummary(description, agentType), { data });
            }
            else if (TASK_OUTPUT_TOOLS.has(name)) {
                const description = input.content || input.result || '';
                const agentType = input.subagent_type || undefined;
                const data = {
                    category: 'task',
                    description,
                    ...(agentType ? { agentType } : {}),
                    ...(result ? { resultSummary: result.slice(0, 100) } : {}),
                };
                collector.add('TaskOutput', subagentSummary(description, agentType), { data });
            }
            else if (ASK_TOOLS.has(name)) {
                const question = truncate(input.question || input.prompt || '', 80);
                const data = { category: 'ask', question };
                collector.add('AskUserQuestion', `ask: "${question}"`, { data });
            }
            else if (name.startsWith('mcp__') || name.includes('___') || name.includes('-')) {
                // MCP tools — check for thinking/reasoning tools first
                if (config.mcp.thinkingTools.extractReasoning && isThinkingTool(name)) {
                    const maxChars = config.mcp.thinkingTools.maxReasoningChars;
                    const thought = truncate(input.thought || '', maxChars);
                    const outcome = truncate(input.outcome || '', maxChars);
                    const rawNextAction = input.next_action;
                    const nextAction = typeof rawNextAction === 'string'
                        ? truncate(rawNextAction, maxChars)
                        : rawNextAction
                            ? truncate(JSON.stringify(rawNextAction), maxChars)
                            : undefined;
                    const stepNumber = typeof input.step_number === 'number' ? input.step_number : undefined;
                    const data = {
                        category: 'reasoning',
                        toolName: name,
                        ...(stepNumber !== undefined ? { stepNumber } : {}),
                        ...(thought ? { thought } : {}),
                        ...(outcome ? { outcome } : {}),
                        ...(nextAction ? { nextAction } : {}),
                    };
                    const label = `reasoning step${stepNumber ? ` #${stepNumber}` : ''}: ${truncate(thought || outcome || 'thinking', 60)}`;
                    collector.add(name, label, { data });
                }
                else {
                    const params = truncateParams(input, config.mcp.paramChars);
                    const data = {
                        category: 'mcp',
                        toolName: name,
                        ...(params ? { params } : {}),
                        ...(result ? { result: result.slice(0, config.mcp.resultChars) } : {}),
                    };
                    collector.add(name, mcpSummary(name, JSON.stringify(input).slice(0, config.mcp.paramChars), result?.slice(0, 80)), { data });
                }
            }
            else {
                // Generic/unknown tool — treat as MCP-like
                const params = truncateParams(input, config.mcp.paramChars);
                const data = {
                    category: 'mcp',
                    toolName: name,
                    ...(params ? { params } : {}),
                    ...(result ? { result: result.slice(0, config.mcp.resultChars) } : {}),
                };
                collector.add(name, withResult(`${name}(${JSON.stringify(input).slice(0, config.mcp.paramChars)})`, result?.slice(0, 80)), {
                    data,
                });
            }
        }
    }
    return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}
// ── Helpers ─────────────────────────────────────────────────────────────────
/** Check if a tool name indicates a thinking/reasoning tool */
export function isThinkingTool(name) {
    return name.toLowerCase().includes('think');
}
function getInputString(input, key) {
    const value = input[key];
    return typeof value === 'string' ? value : '';
}
function extractPatchFilePaths(patch) {
    const paths = new Set();
    for (const line of patch.split('\n')) {
        const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: ([^\t\r\n]+)/) ||
            line.match(/^[-+]{3}\s+(?:[ab]\/)?([^\t\r\n]+)/);
        if (!match?.[1])
            continue;
        const filePath = match[1].trim();
        if (filePath && filePath !== '/dev/null')
            paths.add(filePath);
    }
    return Array.from(paths);
}
/** Truncate each param value to maxChars and format as compact string */
function truncateParams(input, maxChars = 100) {
    const parts = [];
    for (const [key, val] of Object.entries(input)) {
        const str = typeof val === 'string' ? val : (JSON.stringify(val) ?? '');
        parts.push(`${key}=${truncate(str, maxChars)}`);
    }
    return parts.join(', ');
}
/** Parse match count from grep result text — returns undefined if ambiguous */
function parseMatchCount(result) {
    const m = result.match(/(?:found|matched)\s+(\d+)/i) || result.match(/(\d+)\s+(?:match|result|hit)/i);
    if (m)
        return parseInt(m[1], 10);
    return undefined;
}
/** Parse file count from glob result text — returns undefined if ambiguous */
function parseFileCount(result) {
    const m = result.match(/(?:found|returned)\s+(\d+)/i) || result.match(/(\d+)\s+(?:file|match|result|entr)/i);
    if (m)
        return parseInt(m[1], 10);
    return undefined;
}
/**
 * Extract thinking/reasoning highlights from Anthropic-style messages.
 * Returns up to `limit` first-line summaries from thinking blocks.
 * Shared by Claude, Droid, and Cursor parsers.
 */
export function extractThinkingHighlights(messages, maxHighlights, config = getPreset('standard')) {
    const limit = maxHighlights ?? config.thinking.maxHighlights;
    const reasoning = [];
    for (const msg of messages) {
        if (reasoning.length >= limit)
            break;
        if (!Array.isArray(msg.content))
            continue;
        for (const item of msg.content) {
            if (reasoning.length >= limit)
                break;
            if (item.type !== 'thinking')
                continue;
            const text = item.thinking || item.text || '';
            if (text.length > 20) {
                const firstLine = text.split(/[.\n]/)[0]?.trim();
                if (firstLine)
                    reasoning.push(truncate(firstLine, 200));
            }
        }
    }
    return reasoning;
}
//# sourceMappingURL=tool-extraction.js.map