import * as crypto from 'crypto';

/**
 * WormholeCodeGenerator — Generates human-readable, cryptographically secure
 * 3-word codes for P2P session establishment.
 *
 * Design Rationale:
 *  - The code serves a dual purpose:
 *    1. Signaling channel identifier (hashed to create a room ID)
 *    2. Cryptographic seed for symmetric key derivation (via scrypt)
 *
 *  - Word list: 256 curated, common English words per slot.
 *    With 3 words from 256-word lists, entropy = 3 * log2(256) = 24 bits.
 *    This is intentionally short-lived — codes are valid only for a single
 *    transfer session (minutes, not hours). The scrypt KDF makes brute-force
 *    attacks computationally expensive even on this entropy level.
 *
 *  - Words are chosen to be:
 *    - Unambiguous (no homophones or easily confused words)
 *    - Easy to spell and communicate verbally
 *    - Lowercase only, alphabetic characters only
 *
 *  - Cryptographic randomness: Uses crypto.randomInt() which is backed by
 *    the OS CSPRNG, ensuring unpredictable word selection.
 */
export class WormholeCodeGenerator {

    /**
     * Curated word lists — 256 words per slot for 24 bits of entropy.
     * Words are friendly, unambiguous, and easy to communicate verbally.
     */
    private static readonly WORD_LIST: string[] = [
        // Nature & Animals
        'apple', 'amber', 'aspen', 'atlas', 'birch', 'bloom', 'brave', 'brook',
        'cedar', 'chair', 'chase', 'chess', 'cliff', 'cloud', 'coral', 'crane',
        'daisy', 'delta', 'denim', 'drift', 'eagle', 'ember', 'fable', 'fern',
        'finch', 'flame', 'forge', 'frost', 'gleam', 'globe', 'grain', 'grove',
        'haven', 'hazel', 'holly', 'honey', 'ivory', 'jewel', 'jolly', 'karma',
        'lemon', 'lilac', 'linen', 'lunar', 'maple', 'marsh', 'mango', 'merit',
        'noble', 'north', 'novel', 'ocean', 'olive', 'onion', 'orbit', 'otter',
        'pearl', 'peach', 'petal', 'pilot', 'plume', 'polar', 'prism', 'pulse',

        // Objects & Places
        'quilt', 'quest', 'radar', 'raven', 'river', 'robin', 'royal', 'rusty',
        'sage', 'satin', 'scout', 'shell', 'shore', 'silk', 'slate', 'solar',
        'spark', 'spice', 'stamp', 'steam', 'steel', 'stone', 'storm', 'sugar',
        'swift', 'table', 'tiger', 'timber', 'torch', 'trail', 'tulip', 'urban',
        'vapor', 'vault', 'vivid', 'wagon', 'waltz', 'wheat', 'whale', 'willow',
        'yield', 'zebra', 'acorn', 'arrow', 'badge', 'beach', 'berry', 'blend',
        'bliss', 'bonus', 'brain', 'cabin', 'camel', 'candy', 'cargo', 'chain',
        'charm', 'cider', 'cloak', 'coach', 'coast', 'comet', 'crown', 'dance',

        // Actions & Qualities
        'diver', 'dream', 'dusk', 'dwarf', 'flair', 'fleet', 'flint', 'flora',
        'focus', 'fresh', 'frost', 'gamma', 'glyph', 'grace', 'guard', 'guide',
        'happy', 'heart', 'hedge', 'heron', 'hotel', 'house', 'humid', 'hyper',
        'index', 'inlet', 'ivory', 'joint', 'judge', 'kayak', 'knack', 'known',
        'labor', 'lance', 'latch', 'layer', 'level', 'light', 'lodge', 'logic',
        'lotus', 'lucid', 'lyric', 'magic', 'manor', 'media', 'metal', 'minor',
        'model', 'moose', 'mural', 'music', 'noted', 'oasis', 'omega', 'opera',
        'orbit', 'oxide', 'panda', 'panel', 'paper', 'piano', 'pixel', 'plaza',

        // More words
        'plumb', 'point', 'power', 'pride', 'prize', 'proxy', 'queen', 'quiet',
        'ranch', 'rapid', 'realm', 'rebel', 'reign', 'relay', 'ridge', 'rival',
        'roast', 'rogue', 'round', 'rover', 'rumba', 'rural', 'salsa', 'sandy',
        'sauna', 'scale', 'scene', 'scope', 'sigma', 'sleek', 'smart', 'snowy',
        'solid', 'sonic', 'south', 'space', 'spine', 'spray', 'staid', 'stoke',
        'surge', 'swirl', 'tango', 'tempo', 'theta', 'thorn', 'tidal', 'toast',
        'token', 'topaz', 'trace', 'trend', 'trout', 'trunk', 'ultra', 'umbra',
        'unity', 'upper', 'valid', 'valor', 'verse', 'vigor', 'viola', 'vista',
    ];

    /**
     * Generate a cryptographically secure 3-word wormhole code.
     *
     * Uses crypto.randomInt() backed by the OS CSPRNG for unpredictable selection.
     *
     * @returns A code in the format "word1-word2-word3" (e.g., "apple-brave-chair")
     */
    public generateCode(): string {
        const listLength = WormholeCodeGenerator.WORD_LIST.length;
        const words: string[] = [];

        for (let i = 0; i < 3; i++) {
            const index = crypto.randomInt(0, listLength);
            words.push(WormholeCodeGenerator.WORD_LIST[index]);
        }

        return words.join('-');
    }

    /**
     * Validate that a code matches the expected 3-word format.
     *
     * Checks:
     *  - Exactly 3 words separated by hyphens
     *  - Each word is non-empty
     *  - Each word contains only lowercase alphabetic characters
     *
     * Note: We intentionally do NOT check if words are in our list,
     * because the receiver might be using a different version of the extension.
     *
     * @param code The code string to validate.
     * @returns An object with `valid` (boolean) and optional `error` (string).
     */
    public validateCode(code: string): { valid: boolean; error?: string } {
        if (!code || typeof code !== 'string') {
            return { valid: false, error: 'Code must be a non-empty string.' };
        }

        const trimmed = code.trim().toLowerCase();
        const parts = trimmed.split('-');

        if (parts.length !== 3) {
            return {
                valid: false,
                error: `Code must contain exactly 3 words separated by hyphens. Got ${parts.length} part(s).`,
            };
        }

        for (let i = 0; i < parts.length; i++) {
            const word = parts[i];
            if (word.length === 0) {
                return {
                    valid: false,
                    error: `Word ${i + 1} is empty. Each word must be non-empty.`,
                };
            }
            if (!/^[a-z]+$/.test(word)) {
                return {
                    valid: false,
                    error: `Word ${i + 1} ("${word}") contains invalid characters. Only lowercase letters are allowed.`,
                };
            }
        }

        return { valid: true };
    }

    /**
     * Normalize a code to lowercase and trim whitespace.
     */
    public normalizeCode(code: string): string {
        return code.trim().toLowerCase();
    }

    /**
     * Get the total number of possible codes (for entropy calculation).
     * entropy = log2(possibleCodes)
     */
    public getEntropyBits(): number {
        const listLength = WormholeCodeGenerator.WORD_LIST.length;
        return Math.log2(Math.pow(listLength, 3));
    }
}
