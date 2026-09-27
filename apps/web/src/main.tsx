import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ColorSchemeScript } from '@mantine/core';

import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';

import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
    <>
        <ColorSchemeScript defaultColorScheme="dark" />
        <StrictMode>
            <App />
        </StrictMode>
    </>,
);
