// Mirror of apps/api/src/domain/languages.ts. The admin stream dropdown is built
// from SUPPORTED_LANGUAGES; the API is the source of truth for validation. Both
// lists are pinned by an identical EXPECTED literal in each app's
// languages.test.ts (drift guard) — keep the two lists in sync.

export type LanguageRegion = 'Indian' | 'European' | 'East Asian' | 'Southeast Asian';

export interface SupportedLanguage {
    code: string;
    name: string;
    nativeName: string;
    region: LanguageRegion;
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
    { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', region: 'Indian' },
    { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', region: 'Indian' },
    { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', region: 'Indian' },
    { code: 'mr', name: 'Marathi', nativeName: 'मराठी', region: 'Indian' },
    { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', region: 'Indian' },
    { code: 'ur', name: 'Urdu', nativeName: 'اردو', region: 'Indian' },
    { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી', region: 'Indian' },
    { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', region: 'Indian' },
    { code: 'or', name: 'Odia', nativeName: 'ଓଡ଼ିଆ', region: 'Indian' },
    { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', region: 'Indian' },
    { code: 'ne', name: 'Nepali', nativeName: 'नेपाली', region: 'Indian' },
    { code: 'en', name: 'English', nativeName: 'English', region: 'European' },
    { code: 'de', name: 'German', nativeName: 'Deutsch', region: 'European' },
    { code: 'es', name: 'Spanish', nativeName: 'Español', region: 'European' },
    { code: 'fr', name: 'French', nativeName: 'Français', region: 'European' },
    { code: 'it', name: 'Italian', nativeName: 'Italiano', region: 'European' },
    {
        code: 'pt',
        name: 'Portuguese',
        nativeName: 'Português',
        region: 'European',
    },
    { code: 'ro', name: 'Romanian', nativeName: 'Română', region: 'European' },
    { code: 'ru', name: 'Russian', nativeName: 'Русский', region: 'European' },
    { code: 'zh', name: 'Mandarin', nativeName: '中文', region: 'East Asian' },
    { code: 'ja', name: 'Japanese', nativeName: '日本語', region: 'East Asian' },
    { code: 'ko', name: 'Korean', nativeName: '한국어', region: 'East Asian' },
    {
        code: 'id',
        name: 'Indonesian',
        nativeName: 'Bahasa Indonesia',
        region: 'Southeast Asian',
    },
    {
        code: 'ms',
        name: 'Malay',
        nativeName: 'Bahasa Melayu',
        region: 'Southeast Asian',
    },
    {
        code: 'tl',
        name: 'Filipino',
        nativeName: 'Filipino',
        region: 'Southeast Asian',
    },
    {
        code: 'vi',
        name: 'Vietnamese',
        nativeName: 'Tiếng Việt',
        region: 'Southeast Asian',
    },
    { code: 'th', name: 'Thai', nativeName: 'ไทย', region: 'Southeast Asian' },
    {
        code: 'my',
        name: 'Burmese',
        nativeName: 'မြန်မာ',
        region: 'Southeast Asian',
    },
    { code: 'km', name: 'Khmer', nativeName: 'ខ្មែរ', region: 'Southeast Asian' },
    { code: 'lo', name: 'Lao', nativeName: 'ລາວ', region: 'Southeast Asian' },
];

export function getLanguageName(code: string): string | undefined {
    return SUPPORTED_LANGUAGES.find((language) => language.code === code)?.name;
}
