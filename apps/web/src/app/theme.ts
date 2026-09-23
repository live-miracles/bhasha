import { createTheme } from '@mantine/core';

const brand = [
    '#fff4e8',
    '#fce2c7',
    '#f7c79c',
    '#efaa6b',
    '#e38f4b',
    '#d47c38',
    '#c7772e',
    '#a96025',
    '#874b21',
    '#6d3b1b',
] as const;

export const bhashaTheme = createTheme({
    primaryColor: 'brand',
    primaryShade: 6,
    colors: { brand },
    defaultRadius: 'md',
    fontFamily:
        'Noto Sans, Noto Sans Devanagari, Noto Sans Tamil, Noto Sans Telugu, Noto Sans Bengali, Noto Sans Gujarati, Noto Sans Kannada, Noto Sans Oriya, Noto Sans Malayalam, Noto Naskh Arabic, ui-sans-serif, system-ui, sans-serif',
    headings: {
        fontFamily:
            'Noto Sans, Noto Sans Devanagari, Noto Sans Tamil, Noto Sans Telugu, Noto Sans Bengali, Noto Sans Gujarati, Noto Sans Kannada, Noto Sans Oriya, Noto Sans Malayalam, Noto Naskh Arabic, ui-sans-serif, system-ui, sans-serif',
        fontWeight: '700',
    },
    other: {
        live: '#16a249',
        silent: '#d97706',
        offline: '#8f97a3',
    },
});
