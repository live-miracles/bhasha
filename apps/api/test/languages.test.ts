import { describe, expect, it } from 'vitest';
import {
    SUPPORTED_LANGUAGES,
    SUPPORTED_LANGUAGE_CODES,
    getLanguageName,
    isSupportedLanguageCode,
} from '../src/domain/languages';

const EXPECTED_CODES = [
    'af',
    'sq',
    'ar',
    'az',
    'be',
    'bn',
    'bs',
    'bg',
    'my',
    'ca',
    'zh',
    'hr',
    'cs',
    'da',
    'nl',
    'en',
    'et',
    'fil',
    'fi',
    'fr',
    'fy',
    'gl',
    'ka',
    'de',
    'el',
    'gn',
    'gu',
    'he',
    'hi',
    'hu',
    'is',
    'id',
    'it',
    'ja',
    'kn',
    'km',
    'ko',
    'ky',
    'lo',
    'lv',
    'ln',
    'lt',
    'mk',
    'ms',
    'ml',
    'mr',
    'ne',
    'no',
    'nb',
    'or',
    'fa',
    'pl',
    'pt',
    'pa',
    'ro',
    'ru',
    'sk',
    'sl',
    'es',
    'sw',
    'sv',
    'ta',
    'te',
    'th',
    'tl',
    'tr',
    'uk',
    'ur',
    'uz',
    'vi',
    'cy',
    'zu',
];

describe('supported languages', () => {
    it('contains the deduplicated Google language catalog in order', () => {
        expect(SUPPORTED_LANGUAGES).toHaveLength(72);
        expect(SUPPORTED_LANGUAGES.map((language) => language.code)).toEqual(EXPECTED_CODES);
        expect(new Set(SUPPORTED_LANGUAGES.map((language) => language.name)).size).toBe(72);
    });

    it('does not expose regional variants as separate choices', () => {
        expect(getLanguageName('en')).toBe('English');
        expect(getLanguageName('zh')).toBe('Chinese');
        expect(isSupportedLanguageCode('en-US')).toBe(false);
        expect(isSupportedLanguageCode('en-IN')).toBe(false);
        expect(isSupportedLanguageCode('zh-CN')).toBe(false);
    });

    it('exposes a code set for membership checks', () => {
        expect(SUPPORTED_LANGUAGE_CODES.size).toBe(72);
        expect(isSupportedLanguageCode('hi')).toBe(true);
        expect(isSupportedLanguageCode('fil')).toBe(true);
        expect(isSupportedLanguageCode('tl')).toBe(true);
        expect(isSupportedLanguageCode('zz')).toBe(false);
        expect(isSupportedLanguageCode('')).toBe(false);
    });

    it('preserves native names and provides a stable fallback for new entries', () => {
        expect(getLanguageName('hi')).toBe('Hindi');
        expect(SUPPORTED_LANGUAGES.find((language) => language.code === 'hi')?.nativeName).toBe(
            'हिन्दी',
        );
        expect(SUPPORTED_LANGUAGES.find((language) => language.code === 'af')?.nativeName).toBe(
            'Afrikaans',
        );
        expect(getLanguageName('zz')).toBeUndefined();
        expect(getLanguageName('fil')).toBe('Filipino');
        expect(getLanguageName('tl')).toBe('Tagalog');
    });
});
