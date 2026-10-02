// Mirror of apps/api/src/domain/languages.ts. The API is the source of truth for validation; keep both catalogs identical.
//
// Based on the Google language list used by the sibling multi-lang-qa project.
// Regional variants are represented by one language (for example, all English
// variants use en). Language codes and names follow the Google language list.

export type LanguageRegion = 'Indian' | 'European' | 'East Asian' | 'Southeast Asian' | 'Other';

export interface SupportedLanguage {
    code: string;
    name: string;
    nativeName: string;
    region: LanguageRegion;
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
    { code: 'af', name: 'Afrikaans', nativeName: 'Afrikaans', region: 'Other' },
    { code: 'sq', name: 'Albanian', nativeName: 'Albanian', region: 'European' },
    { code: 'ar', name: 'Arabic', nativeName: 'العربية', region: 'Other' },
    { code: 'az', name: 'Azerbaijani', nativeName: 'Azerbaijani', region: 'Other' },
    { code: 'be', name: 'Belarusian', nativeName: 'Беларуская', region: 'European' },
    { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', region: 'Indian' },
    { code: 'bs', name: 'Bosnian', nativeName: 'Bosanski', region: 'European' },
    { code: 'bg', name: 'Bulgarian', nativeName: 'Български', region: 'European' },
    { code: 'my', name: 'Burmese', nativeName: 'မြန်မာ', region: 'Southeast Asian' },
    { code: 'ca', name: 'Catalan', nativeName: 'Català', region: 'European' },
    { code: 'zh', name: 'Chinese', nativeName: '中文', region: 'East Asian' },
    { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski', region: 'European' },
    { code: 'cs', name: 'Czech', nativeName: 'Čeština', region: 'European' },
    { code: 'da', name: 'Danish', nativeName: 'Dansk', region: 'European' },
    { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', region: 'European' },
    { code: 'en', name: 'English', nativeName: 'English', region: 'European' },
    { code: 'et', name: 'Estonian', nativeName: 'Eesti', region: 'European' },
    { code: 'fil', name: 'Filipino', nativeName: 'Filipino', region: 'Southeast Asian' },
    { code: 'fi', name: 'Finnish', nativeName: 'Suomi', region: 'European' },
    { code: 'fr', name: 'French', nativeName: 'Français', region: 'European' },
    { code: 'fy', name: 'Frisian', nativeName: 'Frysk', region: 'European' },
    { code: 'gl', name: 'Galician', nativeName: 'Galego', region: 'European' },
    { code: 'ka', name: 'Georgian', nativeName: 'ქართული', region: 'Other' },
    { code: 'de', name: 'German', nativeName: 'Deutsch', region: 'European' },
    { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', region: 'European' },
    { code: 'gn', name: 'Guarani', nativeName: 'Guaraní', region: 'Other' },
    { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી', region: 'Indian' },
    { code: 'he', name: 'Hebrew', nativeName: 'עברית', region: 'Other' },
    { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', region: 'Indian' },
    { code: 'hu', name: 'Hungarian', nativeName: 'Magyar', region: 'European' },
    { code: 'is', name: 'Icelandic', nativeName: 'Íslenska', region: 'European' },
    { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', region: 'Southeast Asian' },
    { code: 'it', name: 'Italian', nativeName: 'Italiano', region: 'European' },
    { code: 'ja', name: 'Japanese', nativeName: '日本語', region: 'East Asian' },
    { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', region: 'Indian' },
    { code: 'km', name: 'Khmer', nativeName: 'ខ្មែរ', region: 'Southeast Asian' },
    { code: 'ko', name: 'Korean', nativeName: '한국어', region: 'East Asian' },
    { code: 'ky', name: 'Kyrgyz', nativeName: 'Кыргызча', region: 'Other' },
    { code: 'lo', name: 'Lao', nativeName: 'ລາວ', region: 'Southeast Asian' },
    { code: 'lv', name: 'Latvian', nativeName: 'Latviešu', region: 'European' },
    { code: 'ln', name: 'Lingala', nativeName: 'Lingála', region: 'Other' },
    { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių', region: 'European' },
    { code: 'mk', name: 'Macedonian', nativeName: 'Македонски', region: 'European' },
    { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu', region: 'Southeast Asian' },
    { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', region: 'Indian' },
    { code: 'mr', name: 'Marathi', nativeName: 'मराठी', region: 'Indian' },
    { code: 'ne', name: 'Nepali', nativeName: 'नेपाली', region: 'Indian' },
    { code: 'no', name: 'Norwegian', nativeName: 'Norsk', region: 'European' },
    { code: 'nb', name: 'Norwegian Bokmal', nativeName: 'Norsk bokmål', region: 'European' },
    { code: 'or', name: 'Odia', nativeName: 'ଓଡ଼ିଆ', region: 'Indian' },
    { code: 'fa', name: 'Persian', nativeName: 'فارسی', region: 'Other' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski', region: 'European' },
    { code: 'pt', name: 'Portuguese', nativeName: 'Português', region: 'European' },
    { code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', region: 'Indian' },
    { code: 'ro', name: 'Romanian', nativeName: 'Română', region: 'European' },
    { code: 'ru', name: 'Russian', nativeName: 'Русский', region: 'European' },
    { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina', region: 'European' },
    { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina', region: 'European' },
    { code: 'es', name: 'Spanish', nativeName: 'Español', region: 'European' },
    { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili', region: 'Other' },
    { code: 'sv', name: 'Swedish', nativeName: 'Svenska', region: 'European' },
    { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', region: 'Indian' },
    { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', region: 'Indian' },
    { code: 'th', name: 'Thai', nativeName: 'ไทย', region: 'Southeast Asian' },
    { code: 'tl', name: 'Tagalog', nativeName: 'Tagalog', region: 'Southeast Asian' },
    { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', region: 'Other' },
    { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', region: 'European' },
    { code: 'ur', name: 'Urdu', nativeName: 'اردو', region: 'Indian' },
    { code: 'uz', name: 'Uzbek', nativeName: 'Oʻzbekcha', region: 'Other' },
    { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', region: 'Southeast Asian' },
    { code: 'cy', name: 'Welsh', nativeName: 'Cymraeg', region: 'European' },
    { code: 'zu', name: 'Zulu', nativeName: 'isiZulu', region: 'Other' },
];

export const SUPPORTED_LANGUAGE_CODES: ReadonlySet<string> = new Set(
    SUPPORTED_LANGUAGES.map((language) => language.code),
);

export function isSupportedLanguageCode(code: string): boolean {
    return SUPPORTED_LANGUAGE_CODES.has(code);
}

export function findSupportedLanguage(code: string): SupportedLanguage | undefined {
    return SUPPORTED_LANGUAGES.find((language) => language.code === code);
}

export function getLanguageName(code: string): string | undefined {
    return findSupportedLanguage(code)?.name;
}
