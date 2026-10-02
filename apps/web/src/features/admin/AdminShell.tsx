import { Badge, Group, Image, MantineProvider, Paper, Text, ThemeIcon } from '@mantine/core';
import { type ReactNode } from 'react';
import { bhashaTheme } from '../../app/theme';

type AdminLayoutProps = {
    children: ReactNode;
};

type KpiTileProps = {
    label: string;
    value: string;
};

type StatusPillProps = {
    tone: 'live' | 'silent' | 'offline';
    children: ReactNode;
};

export function AdminUiProvider({ children }: { children: ReactNode }) {
    return (
        <MantineProvider theme={bhashaTheme} defaultColorScheme="dark">
            {children}
        </MantineProvider>
    );
}

export function KpiTile({ label, value }: KpiTileProps) {
    return (
        <Paper p="md" radius="md" withBorder>
            <Text fw={700} size="xl">
                {value}
            </Text>
            <Text c="dimmed" size="sm">
                {label}
            </Text>
        </Paper>
    );
}

export function StatusPill({ tone, children }: StatusPillProps) {
    const color =
        tone === 'live'
            ? 'green'
            : tone === 'silent'
              ? 'yellow'
              : tone === 'offline'
                ? 'gray'
                : 'gray';

    return (
        <Badge color={color} variant={tone === 'live' ? 'filled' : 'light'}>
            {children}
        </Badge>
    );
}

export function AdminBrand() {
    return (
        <Group gap="sm" wrap="nowrap">
            <ThemeIcon color="brand" radius="md" size="lg" variant="light">
                <Image alt="" src="/branding/logo.png" w={24} />
            </ThemeIcon>
            <div>
                <Text fw={800} size="sm" tt="uppercase">
                    Bhasha
                </Text>
                <Text c="dimmed" size="xs">
                    Event translation
                </Text>
            </div>
        </Group>
    );
}

export function AdminLayout({ children }: AdminLayoutProps) {
    return (
        <AdminUiProvider>
            <div className="admin-app">
                <div className="admin-layout">{children}</div>
            </div>
        </AdminUiProvider>
    );
}
