/**
 * Simple log-level logger for continues.
 * Replaces empty catch {} blocks with debug/warn output.
 *
 * Usage:
 *   import { logger, setLogLevel } from './logger.js';
 *   logger.debug('parsing session', filePath);
 *   logger.warn('skipping invalid line', line);
 *
 * Log levels (increasing verbosity):
 *   silent → error → warn → info → debug
 *
 * Control via:
 *   - setLogLevel('debug') from code
 *   - CONTINUES_DEBUG=1 env var (sets 'debug')
 *   - --verbose CLI flag (sets 'info')
 *   - --debug CLI flag (sets 'debug')
 */
const LEVELS = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
};
let currentLevel = 'silent';
/** Set the global log level. */
export function setLogLevel(level) {
    currentLevel = level;
}
/** Get the current log level. */
export function getLogLevel() {
    return currentLevel;
}
function shouldLog(level) {
    return LEVELS[level] <= LEVELS[currentLevel];
}
function formatArgs(args) {
    return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}
export const logger = {
    error(...args) {
        if (shouldLog('error')) {
            console.error(`[continues:error] ${formatArgs(args)}`);
        }
    },
    warn(...args) {
        if (shouldLog('warn')) {
            console.warn(`[continues:warn] ${formatArgs(args)}`);
        }
    },
    info(...args) {
        if (shouldLog('info')) {
            console.info(`[continues:info] ${formatArgs(args)}`);
        }
    },
    debug(...args) {
        if (shouldLog('debug')) {
            console.debug(`[continues:debug] ${formatArgs(args)}`);
        }
    },
};
// Auto-configure from environment
if (process.env.CONTINUES_DEBUG === '1' || process.env.CONTINUES_DEBUG === 'true') {
    setLogLevel('debug');
}
//# sourceMappingURL=logger.js.map