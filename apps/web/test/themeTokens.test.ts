import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Dark mode is the default theme. A control whose background is a literal light colour but whose
// label colour comes from a theme token ends up white-on-white in dark mode (this is exactly how
// the listener's Stop and volume buttons broke). These selectors must take their backgrounds
// from the --lp-* / --adm-* tokens, which have dark values.
const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

const LITERAL_COLOUR = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|white$|black$)/i;

function declarations(selector: string): { property: string; value: string }[] {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g');
    const found: { property: string; value: string }[] = [];
    for (const match of css.matchAll(block)) {
        for (const line of (match[1] ?? '').split(';')) {
            const [property, ...rest] = line.split(':');
            if (property && rest.length) {
                found.push({ property: property.trim(), value: rest.join(':').trim() });
            }
        }
    }
    return found;
}

const THEMED_CONTROLS = [
    '.listener-alert',
    '.lp-btn--switch:hover',
    '.lp-btn--stop',
    '.lp-btn--stop:hover',
    '.lp-tile--offline .lp-btn--play',
    '.lp-vol-btn',
    '.lp-vol-btn:hover',
    '.translator-control-btn',
    '.translator-control-btn:hover',
    '.translator-control-btn--stop',
    '.audio-settings-btn:hover',
    '.audio-sheet-close',
    '.audio-sheet-close:hover',
    '.approver-camera-help',
    '.admin-alert',
];

describe('theme tokens in styles.css', () => {
    it.each(THEMED_CONTROLS)('%s takes its background from a theme token', (selector) => {
        const backgrounds = declarations(selector).filter(
            ({ property }) => property === 'background' || property === 'background-color',
        );

        expect(backgrounds.length, `no background rule found for ${selector}`).toBeGreaterThan(0);
        for (const { value } of backgrounds) {
            expect(value, `${selector} uses a literal colour`).not.toMatch(LITERAL_COLOUR);
        }
    });

    it('defines every secondary-control token for both light and dark', () => {
        const root = css.slice(
            css.indexOf(':root {'),
            css.indexOf("[data-mantine-color-scheme='dark'] {"),
        );
        const dark = css.slice(
            css.indexOf("[data-mantine-color-scheme='dark'] {"),
            css.indexOf('* {\n    box-sizing'),
        );
        for (const token of [
            '--lp-control-bg',
            '--lp-control-bg-hover',
            '--lp-control-bg-disabled',
            '--lp-control-border',
            '--lp-button-border',
            '--lp-button-hover',
            '--lp-accent-soft-hover',
            '--lp-focus-ring',
        ]) {
            expect(root, `${token} missing from :root`).toContain(`${token}:`);
            expect(dark, `${token} missing from the dark block`).toContain(`${token}:`);
        }
    });

    it('does not use CSS variables that are never defined and have no fallback', () => {
        const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
        // Variables supplied by Mantine at runtime, or set inline / on other elements.
        const external = /^--(mantine-|lp-tile-btn-width|lp-mic-segment-)/;
        // Only `var(--name)` with no fallback: with a fallback the rule still works, but a bare
        // reference to an undefined variable silently drops the whole declaration.
        const undefinedRefs = [...css.matchAll(/var\((--[\w-]+)\)/g)]
            .map((m) => m[1] as string)
            .filter((name) => !defined.has(name) && !external.test(name));

        expect([...new Set(undefinedRefs)]).toEqual([]);
    });
});
