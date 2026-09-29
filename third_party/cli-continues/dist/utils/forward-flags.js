const FLAG_SPECS = [
    { key: 'dangerouslyBypass', names: ['--dangerously-bypass-approvals-and-sandbox'], valueMode: 'none' },
    { key: 'dangerouslySkipPermissions', names: ['--dangerously-skip-permissions'], valueMode: 'none' },
    { key: 'fullAuto', names: ['--full-auto'], valueMode: 'none' },
    { key: 'askForApproval', names: ['--ask-for-approval', '-a'], valueMode: 'required' },
    { key: 'approvalMode', names: ['--approval-mode'], valueMode: 'required' },
    { key: 'permissionMode', names: ['--permission-mode'], valueMode: 'required' },
    { key: 'allowedMcpServerNames', names: ['--allowed-mcp-server-names'], valueMode: 'required' },
    { key: 'additionalMcpConfig', names: ['--additional-mcp-config'], valueMode: 'required' },
    { key: 'includeDirectories', names: ['--include-directories'], valueMode: 'required' },
    { key: 'disallowedTools', names: ['--disallowed-tools', '--disallowedTools'], valueMode: 'required' },
    { key: 'allowedTools', names: ['--allowed-tools', '--allowedTools'], valueMode: 'required' },
    { key: 'allowTool', names: ['--allow-tool'], valueMode: 'required' },
    { key: 'denyTool', names: ['--deny-tool'], valueMode: 'required' },
    { key: 'approveMcps', names: ['--approve-mcps'], valueMode: 'none' },
    { key: 'addDir', names: ['--add-dir'], valueMode: 'required' },
    { key: 'agent', names: ['--agent'], valueMode: 'required' },
    { key: 'logLevel', names: ['--log-level'], valueMode: 'required' },
    { key: 'mcpConfig', names: ['--mcp-config'], valueMode: 'required' },
    { key: 'workspace', names: ['--workspace'], valueMode: 'required' },
    { key: 'sandbox', names: ['--sandbox', '-s'], valueMode: 'optional' },
    { key: 'model', names: ['--model', '-m'], valueMode: 'required' },
    { key: 'yolo', names: ['--yolo', '-y'], valueMode: 'none' },
    { key: 'allowAll', names: ['--allow-all'], valueMode: 'none' },
    { key: 'force', names: ['--force', '-f'], valueMode: 'none' },
    { key: 'debug', names: ['--debug', '-d'], valueMode: 'optional' },
    { key: 'plan', names: ['--plan'], valueMode: 'none' },
    { key: 'mode', names: ['--mode'], valueMode: 'required' },
    { key: 'cd', names: ['--cd', '-C'], valueMode: 'required' },
    { key: 'config', names: ['--config', '-c'], valueMode: 'required' },
];
function isOptionLike(value) {
    return typeof value === 'string' && value.startsWith('-');
}
function splitInlineValue(token, optionName) {
    const prefix = `${optionName}=`;
    return token.startsWith(prefix) ? token.slice(prefix.length) : undefined;
}
function matchSpecAt(tokens, index, spec) {
    const token = tokens[index];
    for (const name of spec.names) {
        const isExact = token === name;
        const inlineValue = splitInlineValue(token, name);
        if (!isExact && inlineValue === undefined)
            continue;
        if (spec.valueMode === 'none') {
            return {
                occurrence: { key: spec.key, rawIndices: [index], value: true, sourceFlag: name },
                nextIndex: index,
            };
        }
        if (inlineValue !== undefined) {
            return {
                occurrence: { key: spec.key, rawIndices: [index], value: inlineValue, sourceFlag: name },
                nextIndex: index,
            };
        }
        const maybeValue = tokens[index + 1];
        if (maybeValue !== undefined && !isOptionLike(maybeValue)) {
            return {
                occurrence: { key: spec.key, rawIndices: [index, index + 1], value: maybeValue, sourceFlag: name },
                nextIndex: index + 1,
            };
        }
        if (spec.valueMode === 'optional') {
            return {
                occurrence: { key: spec.key, rawIndices: [index], value: true, sourceFlag: name },
                nextIndex: index,
            };
        }
        // Required value missing: keep raw token untouched (do not consume).
        return { nextIndex: index };
    }
    return null;
}
export function parseForwardFlags(tokens) {
    const occurrences = [];
    for (let index = 0; index < tokens.length; index += 1) {
        let matched = false;
        for (const spec of FLAG_SPECS) {
            const result = matchSpecAt(tokens, index, spec);
            if (!result)
                continue;
            if (result.occurrence) {
                occurrences.push(result.occurrence);
            }
            index = result.nextIndex;
            matched = true;
            break;
        }
        if (!matched)
            continue;
    }
    return { tokens: [...tokens], occurrences };
}
function sortByPosition(a, b) {
    return a.rawIndices[0] - b.rawIndices[0];
}
function splitCsv(values) {
    return values
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter(Boolean);
}
function parseBooleanLike(value) {
    if (typeof value === 'boolean')
        return value;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized))
        return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized))
        return false;
    return undefined;
}
export class ForwardFlagMapContext {
    parsed;
    consumed = new Set();
    warnings = [];
    constructor(parsed) {
        this.parsed = parsed;
    }
    all(...keys) {
        return this.parsed.occurrences
            .filter((occ) => keys.includes(occ.key) && occ.rawIndices.every((index) => !this.consumed.has(index)))
            .sort(sortByPosition);
    }
    has(...keys) {
        return this.all(...keys).length > 0;
    }
    latest(...keys) {
        const values = this.all(...keys);
        return values.length > 0 ? values[values.length - 1] : undefined;
    }
    latestString(...keys) {
        const latest = [...this.all(...keys)].reverse().find((occ) => typeof occ.value === 'string');
        return latest && typeof latest.value === 'string' ? latest.value : undefined;
    }
    allStrings(...keys) {
        return this.all(...keys)
            .map((occ) => (typeof occ.value === 'string' ? occ.value : undefined))
            .filter((value) => value !== undefined);
    }
    allCsvStrings(...keys) {
        return splitCsv(this.allStrings(...keys));
    }
    consume(...occurrences) {
        for (const occurrence of occurrences) {
            for (const index of occurrence.rawIndices) {
                this.consumed.add(index);
            }
        }
    }
    consumeKeys(...keys) {
        this.consume(...this.all(...keys));
    }
    consumeLatest(...keys) {
        const latest = this.latest(...keys);
        if (latest)
            this.consume(latest);
        return latest;
    }
    consumeAllStrings(...keys) {
        const occurrences = this.all(...keys).filter((occ) => typeof occ.value === 'string');
        this.consume(...occurrences);
        return occurrences.map((occ) => occ.value);
    }
    consumeAllCsvStrings(...keys) {
        return splitCsv(this.consumeAllStrings(...keys));
    }
    consumeAnyBoolean(...keys) {
        const occurrences = this.all(...keys).filter((occ) => parseBooleanLike(occ.value) === true);
        this.consume(...occurrences);
        return occurrences.length > 0;
    }
    consumedIndices() {
        return new Set(this.consumed);
    }
    passthroughArgs() {
        return this.parsed.tokens.filter((_, index) => !this.consumed.has(index));
    }
    resolveWith(mapper) {
        const result = mapper(this);
        const mappedArgs = result.mappedArgs;
        const passthroughArgs = this.passthroughArgs();
        return {
            mappedArgs,
            passthroughArgs,
            extraArgs: [...mappedArgs, ...passthroughArgs],
            warnings: [...this.warnings, ...(result.warnings || [])],
            parsed: this.parsed,
            consumedIndices: this.consumedIndices(),
        };
    }
}
export function resolveForwardingArgs(rawTokens, mapper) {
    const tokens = rawTokens && rawTokens.length > 0 ? [...rawTokens] : [];
    const parsed = parseForwardFlags(tokens);
    if (!mapper || tokens.length === 0) {
        return {
            mappedArgs: [],
            passthroughArgs: tokens,
            extraArgs: tokens,
            warnings: [],
            parsed,
            consumedIndices: new Set(),
        };
    }
    return new ForwardFlagMapContext(parsed).resolveWith(mapper);
}
export function normalizeAgentSandbox(value) {
    if (value === undefined)
        return undefined;
    if (typeof value === 'boolean')
        return value ? 'enabled' : 'disabled';
    const normalized = value.trim().toLowerCase();
    if (['enabled', 'on', 'true', '1', 'read-only', 'workspace-write'].includes(normalized))
        return 'enabled';
    if (['disabled', 'off', 'false', '0', 'danger-full-access'].includes(normalized))
        return 'disabled';
    return undefined;
}
export function formatForwardArgs(args) {
    return args
        .map((arg) => {
        if (/^[A-Za-z0-9_./:=-]+$/.test(arg))
            return arg;
        return JSON.stringify(arg);
    })
        .join(' ');
}
export function gatherRawForwardArgs(extraArgs, tailArgs) {
    return [...(extraArgs || []), ...(tailArgs || [])];
}
export function resolveTargetForwarding(_target, mapper, options) {
    const rawTokens = gatherRawForwardArgs(options?.rawArgs, options?.tailArgs);
    return resolveForwardingArgs(rawTokens, mapper);
}
//# sourceMappingURL=forward-flags.js.map