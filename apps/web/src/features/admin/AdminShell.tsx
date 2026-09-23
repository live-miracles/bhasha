import {
    AppShell,
    Badge,
    Breadcrumbs,
    Burger,
    Button,
    Group,
    Image,
    MantineProvider,
    NavLink,
    Paper,
    Stack,
    Text,
    ThemeIcon,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Fragment, type ReactNode } from 'react';
import type { AdminRole } from '../../api/admin';
import { bhashaTheme } from '../../app/theme';

type NavItemProps = {
    label: string;
    active: boolean;
    onClick: () => void;
    icon?: ReactNode;
};

export function NavItem({ label, active, onClick, icon }: NavItemProps) {
    return (
        <NavLink
            active={active}
            aria-current={active ? 'page' : undefined}
            component="button"
            label={label}
            leftSection={icon}
            onClick={onClick}
            variant="light"
        />
    );
}

type SidebarProps = {
    programName: string;
    activeSection: string;
    onNavigate: (section: ProgramNavSection) => void;
    onBack: () => void;
};

type AppNavSection = 'programs' | 'deleted' | 'users' | 'account';

type SidebarAppProps = {
    activeSection: AppNavSection;
    onNavigate: (section: AppNavSection) => void;
    role?: AdminRole;
};

type TopBarProps = {
    crumbs: string[];
    action?: ReactNode;
};

type AdminLayoutProps = {
    sidebar: ReactNode;
    children: ReactNode;
};

type KpiTileProps = {
    label: string;
    value: string;
};

type StatusPillProps = {
    tone: 'live' | 'silent' | 'offline' | 'draft' | 'archived';
    children: ReactNode;
};

type ProgramNavSection =
    'overview' | 'status' | 'streams' | 'translators' | 'share' | 'readiness' | 'reports';

const NAV_ICON: Record<ProgramNavSection, ReactNode> = {
    overview: <span aria-hidden="true">▦</span>,
    status: <span aria-hidden="true">⌁</span>,
    streams: <span aria-hidden="true">◉</span>,
    translators: <span aria-hidden="true">♙</span>,
    share: <span aria-hidden="true">⌗</span>,
    readiness: <span aria-hidden="true">✓</span>,
    reports: <span aria-hidden="true">▥</span>,
};

const PROGRAM_NAV_ITEMS: Array<{ section: ProgramNavSection; label: string }> = [
    { section: 'overview', label: 'Overview' },
    { section: 'status', label: 'Status' },
    { section: 'streams', label: 'Streams' },
    { section: 'translators', label: 'Translators' },
    { section: 'share', label: 'Share / QR' },
    { section: 'readiness', label: 'Readiness' },
    { section: 'reports', label: 'Reports' },
];

export function AdminUiProvider({ children }: { children: ReactNode }) {
    return (
        <MantineProvider theme={bhashaTheme} defaultColorScheme="light">
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
                : tone === 'draft'
                  ? 'violet'
                  : 'dark';

    return (
        <Badge color={color} variant={tone === 'live' ? 'filled' : 'light'}>
            {children}
        </Badge>
    );
}

function ShellBrand() {
    return (
        <Group gap="sm" wrap="nowrap">
            <ThemeIcon color="brand" radius="md" size="lg" variant="light">
                <Image alt="" src="/branding/logo.svg" w={24} />
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

export function Sidebar({ programName, activeSection, onNavigate, onBack }: SidebarProps) {
    return (
        <Stack h="100%" gap="sm">
            <ShellBrand />
            <Button justify="flex-start" onClick={onBack} px="xs" variant="subtle">
                ← Programs
            </Button>
            <Text fw={700} lineClamp={2} mt="sm" size="sm">
                {programName}
            </Text>
            <Stack gap={4} mt="xs">
                {PROGRAM_NAV_ITEMS.map((item) => (
                    <NavItem
                        key={item.section}
                        active={activeSection === item.section}
                        icon={NAV_ICON[item.section]}
                        label={item.label}
                        onClick={() => onNavigate(item.section)}
                    />
                ))}
            </Stack>
        </Stack>
    );
}

export function SidebarApp({ activeSection, onNavigate, role }: SidebarAppProps) {
    const navItems: Array<{ section: AppNavSection; label: string }> = [
        { section: 'programs', label: 'Programs' },
        { section: 'deleted', label: 'Recently deleted' },
    ];

    if (role === 'admin') {
        navItems.push({ section: 'users', label: 'Users' });
    }

    navItems.push({ section: 'account', label: 'Account' });

    return (
        <Stack h="100%" gap="sm">
            <ShellBrand />
            <Stack gap={4} mt="md">
                {navItems.map((item) => (
                    <NavItem
                        key={item.section}
                        active={activeSection === item.section}
                        label={item.label}
                        onClick={() => onNavigate(item.section)}
                    />
                ))}
            </Stack>
        </Stack>
    );
}

export function TopBar({ crumbs, action }: TopBarProps) {
    return (
        <Group align="center" justify="space-between" mb="lg" wrap="wrap">
            <Breadcrumbs separator="›">
                {crumbs.map((crumb, index) => (
                    <Fragment key={`${crumb}-${index}`}>
                        <Text
                            c={index === crumbs.length - 1 ? 'dark' : 'dimmed'}
                            fw={index === crumbs.length - 1 ? 700 : 400}
                            size="sm"
                        >
                            {crumb}
                        </Text>
                    </Fragment>
                ))}
            </Breadcrumbs>
            {action}
        </Group>
    );
}

export function AdminLayout({ sidebar, children }: AdminLayoutProps) {
    const [opened, { toggle, close }] = useDisclosure(false);

    return (
        <AdminUiProvider>
            <AppShell
                className="admin-app"
                header={{ height: 64 }}
                navbar={{
                    breakpoint: 'sm',
                    collapsed: { mobile: !opened },
                    width: 256,
                }}
                padding="lg"
            >
                <AppShell.Header>
                    <Group h="100%" justify="space-between" px="lg">
                        <Group gap="sm">
                            <Burger
                                aria-label={opened ? 'Close navigation' : 'Open navigation'}
                                hiddenFrom="sm"
                                onClick={toggle}
                                opened={opened}
                                size="sm"
                            />
                            <Text fw={700} hiddenFrom="sm" size="sm">
                                Bhasha management
                            </Text>
                        </Group>
                    </Group>
                </AppShell.Header>
                <AppShell.Navbar onClick={close} p="md">
                    {sidebar}
                </AppShell.Navbar>
                <AppShell.Main>{children}</AppShell.Main>
            </AppShell>
        </AdminUiProvider>
    );
}
