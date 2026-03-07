/**
 * DotEnvParser — Parses .env files into structured key-value maps
 * with line-level metadata, and validates syntax integrity.
 *
 * Architectural Decisions:
 *  - We parse into a structured representation rather than treating
 *    .env files as raw text. This allows:
 *    1. Precise syntax error reporting with line numbers
 *    2. Key-level comparison against .env.example
 *    3. Semantic diff rather than textual diff
 *
 *  - Validation catches: unescaped quotes, invalid variable names,
 *    missing `=` on non-comment/non-blank lines, and duplicate keys.
 *
 *  - We support standard .env conventions:
 *    - Comments (lines starting with #)
 *    - Empty lines
 *    - Quoted values (single, double, backtick)
 *    - Export prefix (export KEY=VALUE)
 *    - Inline comments after values
 */

export interface EnvEntry {
    /** The variable name */
    key: string;
    /** The parsed value (with quotes stripped) */
    value: string;
    /** The original raw line */
    rawLine: string;
    /** 1-indexed line number */
    lineNumber: number;
}

export interface ParseResult {
    /** Parsed entries (valid key=value pairs) */
    entries: EnvEntry[];
    /** Map of key → value for quick lookups */
    keyValueMap: Map<string, string>;
    /** Syntax errors found during parsing */
    errors: SyntaxError[];
    /** Duplicate key warnings */
    warnings: string[];
    /** Comments preserved from the file */
    comments: Array<{ text: string; lineNumber: number }>;
}

export interface SyntaxError {
    /** 1-indexed line number */
    line: number;
    /** The problematic line content */
    content: string;
    /** Human-readable error description */
    message: string;
}

export class DotEnvParser {
    /**
     * Valid variable name pattern.
     * Supports: UPPER_CASE, lowercase, MiXeD, numbers (not leading).
     */
    private static readonly VAR_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

    /**
     * Parse a .env file's content into a structured representation.
     */
    public parse(content: string): ParseResult {
        const lines = content.split(/\r?\n/);
        const entries: EnvEntry[] = [];
        const keyValueMap = new Map<string, string>();
        const errors: SyntaxError[] = [];
        const warnings: string[] = [];
        const comments: Array<{ text: string; lineNumber: number }> = [];
        const seenKeys = new Set<string>();

        for (let i = 0; i < lines.length; i++) {
            const lineNumber = i + 1;
            const rawLine = lines[i];
            const trimmed = rawLine.trim();

            // Skip empty lines
            if (trimmed === '') {
                continue;
            }

            // Skip comments
            if (trimmed.startsWith('#')) {
                comments.push({ text: trimmed, lineNumber });
                continue;
            }

            // Strip optional `export ` prefix
            const line = trimmed.startsWith('export ')
                ? trimmed.substring(7).trim()
                : trimmed;

            // Must contain `=`
            const eqIdx = line.indexOf('=');
            if (eqIdx === -1) {
                errors.push({
                    line: lineNumber,
                    content: rawLine,
                    message: `Line ${lineNumber}: Missing '=' separator. Expected KEY=VALUE format.`,
                });
                continue;
            }

            const key = line.substring(0, eqIdx).trim();
            let value = line.substring(eqIdx + 1);

            // Validate variable name
            if (!DotEnvParser.VAR_NAME_PATTERN.test(key)) {
                errors.push({
                    line: lineNumber,
                    content: rawLine,
                    message: `Line ${lineNumber}: Invalid variable name "${key}". ` +
                        `Names must start with a letter or underscore, containing only [a-zA-Z0-9_].`,
                });
                continue;
            }

            // Parse the value (handle quotes)
            const parsedValue = this.parseValue(value, lineNumber, errors);

            // Check for duplicate keys
            if (seenKeys.has(key)) {
                warnings.push(
                    `Line ${lineNumber}: Duplicate key "${key}". The later value will overwrite the earlier one.`,
                );
            }
            seenKeys.add(key);

            entries.push({ key, value: parsedValue, rawLine, lineNumber });
            keyValueMap.set(key, parsedValue);
        }

        return { entries, keyValueMap, errors, warnings, comments };
    }

    /**
     * Parse a value, handling quoted strings and inline comments.
     */
    private parseValue(raw: string, lineNumber: number, errors: SyntaxError[]): string {
        let value = raw.trim();

        // Handle quoted values
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('`') && value.endsWith('`'))
        ) {
            // Strip quotes
            const quote = value[0];
            value = value.slice(1, -1);

            // Check for unescaped quotes inside
            if (quote === '"') {
                const unescaped = value.match(/(?<!\\)"/);
                if (unescaped) {
                    errors.push({
                        line: lineNumber,
                        content: raw,
                        message: `Line ${lineNumber}: Unescaped double quote inside double-quoted value.`,
                    });
                }
            }
        } else if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) {
            // Starts with a quote but doesn't end with one — likely an error
            errors.push({
                line: lineNumber,
                content: raw,
                message: `Line ${lineNumber}: Value starts with a quote but is not properly closed.`,
            });
            // Still use the value as-is (strip the leading quote)
            value = value.slice(1);
        } else {
            // Unquoted: strip inline comments (# preceded by whitespace)
            const commentIdx = value.search(/\s+#/);
            if (commentIdx !== -1) {
                value = value.substring(0, commentIdx);
            }
            value = value.trim();
        }

        return value;
    }

    /**
     * Validate .env content and return errors if found.
     * Returns true if the content is valid (no errors).
     */
    public validate(content: string): { valid: boolean; errors: SyntaxError[]; warnings: string[] } {
        const result = this.parse(content);
        return {
            valid: result.errors.length === 0,
            errors: result.errors,
            warnings: result.warnings,
        };
    }

    /**
     * Extract just the keys from a .env file's content.
     */
    public extractKeys(content: string): string[] {
        const result = this.parse(content);
        return result.entries.map(e => e.key);
    }

    /**
     * Compare two sets of keys and find differences.
     */
    public compareKeys(
        incomingKeys: string[],
        localKeys: string[],
    ): { added: string[]; removed: string[]; common: string[] } {
        const localSet = new Set(localKeys);
        const incomingSet = new Set(incomingKeys);

        const added = incomingKeys.filter(k => !localSet.has(k));
        const removed = localKeys.filter(k => !incomingSet.has(k));
        const common = incomingKeys.filter(k => localSet.has(k));

        return { added, removed, common };
    }
}
