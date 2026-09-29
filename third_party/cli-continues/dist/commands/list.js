import chalk from 'chalk';
import ora from 'ora';
import { formatSessionColored } from '../display/format.js';
import { showNoSessionsHelp } from '../display/help.js';
import { getAllSessions, getSessionsBySource, sessionsToJsonl } from '../utils/index.js';
/**
 * List sessions command handler
 */
export async function listCommand(options, context) {
    try {
        // Use simple spinner for non-interactive
        const spinner = context.isTTY && !options.json && !options.jsonl ? ora('Loading sessions...').start() : null;
        let sessions;
        if (options.source) {
            sessions = await getSessionsBySource(options.source, options.rebuild);
        }
        else {
            sessions = await getAllSessions(options.rebuild);
        }
        if (spinner)
            spinner.stop();
        const limit = parseInt(options.limit, 10);
        const displaySessions = sessions.slice(0, limit);
        if (options.json) {
            console.log(JSON.stringify(displaySessions, null, 2));
            return;
        }
        if (options.jsonl) {
            console.log(sessionsToJsonl(displaySessions));
            return;
        }
        if (sessions.length === 0) {
            if (context.isTTY) {
                showNoSessionsHelp();
            }
            else {
                console.log('No sessions found.');
            }
            return;
        }
        // Print header
        console.log(chalk.gray(`Found ${sessions.length} sessions (showing ${displaySessions.length}):`));
        console.log();
        for (const session of displaySessions) {
            console.log(formatSessionColored(session));
        }
    }
    catch (error) {
        console.error(chalk.red('Error:'), error.message);
        process.exitCode = 1;
    }
}
//# sourceMappingURL=list.js.map