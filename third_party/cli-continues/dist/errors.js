/**
 * Typed error hierarchy for continues.
 * Replaces anonymous Error throws with machine-readable error types.
 */
import { TOOL_NAMES } from './types/tool-names.js';
/**
 * Base error for all continues errors.
 * Includes an optional `cause` for error chaining.
 */
export class ContinuesError extends Error {
    name = 'ContinuesError';
    constructor(message, options) {
        super(message, options);
    }
}
/** Thrown when a parser fails to read or interpret session data. */
export class ParseError extends ContinuesError {
    source;
    filePath;
    name = 'ParseError';
    constructor(source, filePath, message, options) {
        super(`[${source}] ${message} (${filePath})`, options);
        this.source = source;
        this.filePath = filePath;
    }
}
/** Thrown when a requested session cannot be found by ID or path. */
export class SessionNotFoundError extends ContinuesError {
    sessionId;
    name = 'SessionNotFoundError';
    constructor(sessionId) {
        super(`Session not found: ${sessionId}`);
        this.sessionId = sessionId;
    }
}
/** Thrown when a tool binary is not available on PATH. */
export class ToolNotAvailableError extends ContinuesError {
    tool;
    name = 'ToolNotAvailableError';
    constructor(tool) {
        super(`Tool not available: ${tool}. Is it installed and on your PATH?`);
        this.tool = tool;
    }
}
/** Thrown when an unknown source name is provided. */
export class UnknownSourceError extends ContinuesError {
    source;
    name = 'UnknownSourceError';
    constructor(source) {
        super(`Unknown source: "${source}". Valid sources: ${TOOL_NAMES.join(', ')}`);
        this.source = source;
    }
}
/** Thrown when the session index cannot be read or written. */
export class IndexError extends ContinuesError {
    name = 'IndexError';
    constructor(message, options) {
        super(message, options);
    }
}
/** Thrown when file storage operations fail (read/write handoff, cache). */
export class StorageError extends ContinuesError {
    filePath;
    name = 'StorageError';
    constructor(filePath, message, options) {
        super(`${message}: ${filePath}`, options);
        this.filePath = filePath;
    }
}
//# sourceMappingURL=errors.js.map