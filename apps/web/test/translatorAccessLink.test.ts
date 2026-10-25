import { afterEach, describe, expect, it } from 'vitest';

import { clearLocationHash, readTranslatorAccessFromHash } from '../src/lib/translatorAccessLink';

describe('readTranslatorAccessFromHash', () => {
    it('reads the stream id and token from the fragment', () => {
        expect(readTranslatorAccessFromHash('#s=stream_hi&t=abc123')).toEqual({
            streamId: 'stream_hi',
            token: 'abc123',
        });
    });

    it('accepts a fragment without the leading #', () => {
        expect(readTranslatorAccessFromHash('t=abc123&s=stream_hi')).toEqual({
            streamId: 'stream_hi',
            token: 'abc123',
        });
    });

    it.each(['', '#', '#s=stream_hi', '#t=abc123', '#s=&t=abc123', '#s=stream_hi&t=', '#x=1'])(
        'ignores an incomplete fragment (%s)',
        (hash) => {
            expect(readTranslatorAccessFromHash(hash)).toBeNull();
        },
    );
});

describe('clearLocationHash', () => {
    afterEach(() => {
        window.history.replaceState(null, '', '/');
    });

    it('removes the fragment but keeps the path and query', () => {
        window.history.replaceState(null, '', '/demo/translate?x=1#s=stream_hi&t=secret');

        clearLocationHash();

        expect(window.location.pathname).toBe('/demo/translate');
        expect(window.location.search).toBe('?x=1');
        expect(window.location.hash).toBe('');
        expect(window.location.href).not.toContain('secret');
    });
});
