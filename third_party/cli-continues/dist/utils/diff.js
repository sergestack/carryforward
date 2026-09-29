/**
 * Minimal diff utilities for handoff context display.
 * No external dependencies — formats old/new strings as unified diff notation.
 */
/**
 * Format new file content as a unified diff (all `+` lines).
 * Used for Write tool calls that create new files.
 */
export function formatNewFileDiff(content, filePath, maxLines = 200) {
    const lines = content.split('\n');
    const header = `--- /dev/null\n+++ b/${filePath}`;
    const capped = lines.slice(0, maxLines);
    const diffLines = capped.map((l) => `+${l}`);
    const truncated = Math.max(0, lines.length - maxLines);
    let diff = `${header}\n${diffLines.join('\n')}`;
    if (truncated > 0) {
        diff += `\n+${truncated} lines truncated`;
    }
    return { diff, truncated };
}
/**
 * Format an edit as a unified diff from old_string → new_string.
 * Since we have the exact replacement strings (not full files),
 * we format them as a hunk with `-` and `+` lines.
 */
export function formatEditDiff(oldStr, newStr, filePath, maxLines = 200) {
    const header = `--- a/${filePath}\n+++ b/${filePath}`;
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const diffLines = [];
    for (const line of oldLines) {
        diffLines.push(`-${line}`);
    }
    for (const line of newLines) {
        diffLines.push(`+${line}`);
    }
    const capped = diffLines.slice(0, maxLines);
    const truncated = Math.max(0, diffLines.length - maxLines);
    let diff = `${header}\n${capped.join('\n')}`;
    if (truncated > 0) {
        diff += `\n+${truncated} lines truncated`;
    }
    return { diff, truncated };
}
/**
 * Extract the last N non-empty lines from command output.
 */
export function extractStdoutTail(output, lines = 5) {
    const allLines = output.split('\n').filter((l) => l.trim().length > 0);
    return allLines.slice(-lines).join('\n');
}
/**
 * Count added/removed lines from a unified diff string.
 */
export function countDiffStats(diff) {
    let added = 0;
    let removed = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++'))
            added++;
        else if (line.startsWith('-') && !line.startsWith('---'))
            removed++;
    }
    return { added, removed };
}
//# sourceMappingURL=diff.js.map