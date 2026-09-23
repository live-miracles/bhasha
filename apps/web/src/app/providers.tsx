import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { bhashaTheme } from './theme';

export function AppProviders({ children }: { children: ReactNode }) {
    const [queryClient] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        retry: false,
                        staleTime: 15_000,
                        refetchOnWindowFocus: false,
                    },
                },
            }),
    );

    return (
        <MantineProvider theme={bhashaTheme} defaultColorScheme="light">
            <Notifications position="top-right" />
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </MantineProvider>
    );
}
