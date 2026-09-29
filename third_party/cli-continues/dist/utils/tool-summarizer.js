/**
 * Shared tool call summarizer — formatting helpers + SummaryCollector.
 * Each parser normalizes its raw tool events and uses these utilities
 * for consistent, concise summaries across all 7 CLIs.
 */
import { getPreset } from '../config/index.js';
// ── Formatting Helpers ──────────────────────────────────────────────────────
/** Truncate a string, adding '...' if it exceeds max length */
export function truncate(s, max) {
    if (s.length <= max)
        return s;
    return s.slice(0, max - 3) + '...';
}
/** Extract exit code from tool result text */
export function extractExitCode(text) {
    if (!text)
        return undefined;
    const m = text.match(/exit(?:ed with)? code[:\s]+(\d+)/i);
    return m ? parseInt(m[1]) : undefined;
}
/** Append ` → "result"` to a summary if result is non-empty */
export function withResult(summary, result) {
    if (!result)
        return summary;
    return `${summary} → "${truncate(result, 80)}"`;
}
/** Format a shell command invocation */
export function shellSummary(cmd, result) {
    let s = `$ ${truncate(cmd, 80)}`;
    const exitCode = extractExitCode(result);
    if (exitCode !== undefined) {
        s += ` → exit ${exitCode}`;
    }
    else if (result) {
        s += ` → "${truncate(result, 80)}"`;
    }
    return s;
}
/** Format a file operation (read/write/edit) */
export function fileSummary(op, filePath, diffStat, isNewFile) {
    let s = `${op} ${filePath}`;
    if (isNewFile) {
        s += ' (new file)';
    }
    else if (diffStat) {
        s += ` (+${diffStat.added} -${diffStat.removed} lines)`;
    }
    return s;
}
/** Format a grep invocation */
export function grepSummary(pattern, targetPath) {
    return `grep "${pattern}" ${targetPath || ''}`.trim();
}
/** Format a glob invocation */
export function globSummary(pattern) {
    return `glob "${pattern}"`;
}
/** Format a web search */
export function searchSummary(query) {
    return `search "${truncate(query, 60)}"`;
}
/** Format a web fetch */
export function fetchSummary(url) {
    return `fetch ${truncate(url, 80)}`;
}
/** Format an MCP or generic tool call */
export function mcpSummary(name, argsStr, result) {
    let s = `${name}(${argsStr})`;
    if (result)
        s += ` → "${truncate(result, 80)}"`;
    return s;
}
/** Format a subagent/task invocation */
export function subagentSummary(desc, type) {
    if (type)
        return `task "${truncate(desc, 60)}" (${type})`;
    return `task-output: ${truncate(desc, 80)}`;
}
// ── SummaryCollector ────────────────────────────────────────────────────────
/** Build per-category sample limits from a VerbosityConfig */
function buildCategoryLimits(config) {
    return {
        // shell / bash
        Bash: config.shell.maxSamples,
        shell: config.shell.maxSamples,
        // write / create
        Write: config.write.maxSamples,
        write: config.write.maxSamples,
        // edit / patch
        Edit: config.edit.maxSamples,
        edit: config.edit.maxSamples,
        // read
        Read: config.read.maxSamples,
        read: config.read.maxSamples,
        // grep / glob / search / fetch
        Grep: config.grep.maxSamples,
        Glob: config.grep.maxSamples,
        WebSearch: config.grep.maxSamples,
        WebFetch: config.grep.maxSamples,
        // mcp / task / ask
        Task: config.mcp.maxSamplesPerNamespace,
        TaskOutput: config.mcp.maxSamplesPerNamespace,
        AskUserQuestion: config.mcp.maxSamplesPerNamespace,
    };
}
const DEFAULT_SAMPLE_LIMIT = 5;
/**
 * Accumulates tool call summaries by category (tool name).
 * Keeps up to N representative samples per category (category-aware limits)
 * and tracks files modified and error counts.
 */
export class SummaryCollector {
    data = new Map();
    files = new Set();
    categoryLimits;
    constructor(config) {
        const resolved = config ?? getPreset('standard');
        this.categoryLimits = buildCategoryLimits(resolved);
    }
    /** Add a tool invocation. Optionally tracks file modification and errors. */
    add(category, summary, opts) {
        if (!this.data.has(category)) {
            this.data.set(category, { count: 0, errorCount: 0, samples: [] });
        }
        const entry = this.data.get(category);
        entry.count++;
        if (opts?.isError)
            entry.errorCount++;
        const maxSamples = this.categoryLimits[category] ?? DEFAULT_SAMPLE_LIMIT;
        if (entry.samples.length < maxSamples) {
            const sample = { summary };
            if (opts?.data)
                sample.data = opts.data;
            entry.samples.push(sample);
        }
        if (opts?.isWrite && opts?.filePath) {
            this.files.add(opts.filePath);
        }
    }
    /** Track a file modification without adding a tool summary entry */
    trackFile(filePath) {
        this.files.add(filePath);
    }
    /** Get aggregated tool usage summaries */
    getSummaries() {
        return Array.from(this.data.entries()).map(([name, { count, errorCount, samples }]) => ({
            name,
            count,
            ...(errorCount > 0 ? { errorCount } : {}),
            samples,
        }));
    }
    /** Get deduplicated list of files modified */
    getFilesModified() {
        return Array.from(this.files);
    }
}
//# sourceMappingURL=tool-summarizer.js.map