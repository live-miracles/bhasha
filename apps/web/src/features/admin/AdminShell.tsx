import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdminRole } from '../../api/admin';

type NavItemProps = {
    label: string;
    active: boolean;
    onClick: () => void;
    icon?: ReactNode;
};

export function NavItem({ label, active, onClick, icon }: NavItemProps) {
    return (
        <button
            type="button"
            className={active ? 'admin-nav-item is-active' : 'admin-nav-item'}
            onClick={onClick}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}

type SidebarProps = {
    programName: string;
    activeSection: string;
    onNavigate: (section: ProgramNavSection) => void;
    onBack: () => void;
};

type AppNavSection = 'programs' | 'deleted' | 'organizations' | 'users' | 'team' | 'account';

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
    overview: (
        <svg
            aria-hidden="true"
            className="admin-nav-icon"
            fill="none"
            height="18"
            viewBox="0 0 24 24"
            width="18"
        >
            <path
                d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="2"
            />
        </svg>
    ),
    status: (
        <svg
            aria-hidden="true"
            className="admin-nav-icon"
            fill="none"
            height="18"
            viewBox="0 0 24 24"
            width="18"
        >
            <path
                d="M3 12h4l2-5 4 10 2-5h6"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
            />
        </svg>
    ),
    streams: (
        <svg
            aria-hidden="true"
            className="admin-nav-icon"
            fill="none"
            height="18"
            viewBox="0 0 24 24"
            width="18"
        >
            <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="2" />
            <path
                d="M8.5 8.5a5 5 0 0 0 0 7m7-7a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8m12.8-12.8a9 9 0 0 1 0 12.8"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
            />
        </svg>
    ),
    translators: (
        <svg
            aria-hidden="true"
            className="admin-nav-icon"
            fill="none"
            height="18"
            viewBox="0 0 24 24"
            width="18"
        >
            <path
                d="M16 20v-1.5a3.5 3.5 0 0 0-7 0V20m3.5-8a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm5.5 1a3 3 0 0 1 3 3v1m-2.5-9a2.5 2.5 0 0 1 0 5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
            />
        </svg>
    ),
    share: (
        <svg
            aria-hidden="true"
            className="admin-nav-icon"
            fill="none"
            height="18"
            viewBox="0 0 24 24"
            width="18"
        >
            <path
                d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm11 1h2v2h-2v-2Zm3 3h2v2h-2v-2Zm-4 0h2v2h-2v-2Zm4-4h2v2h-2v-2Z"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="2"
            />
        </svg>
    ),
    readiness: (
        <svg
            aria-hidden="true"
            className="admin-nav-icon"
            fill="none"
            height="18"
            viewBox="0 0 24 24"
            width="18"
        >
            <path
                d="M9 5h6m-7 3h8m-7 5 2 2 4-5M7 3h10a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
            />
        </svg>
    ),
    reports: (
        <svg
            aria-hidden="true"
            className="admin-nav-icon"
            fill="none"
            height="18"
            viewBox="0 0 24 24"
            width="18"
        >
            <path
                d="M5 19V9m7 10V5m7 14v-7"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
            />
            <path d="M3 19h18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        </svg>
    ),
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

export function KpiTile({ label, value }: KpiTileProps) {
    return (
        <div className="admin-kpi">
            <span className="admin-kpi-value">{value}</span>
            <span className="admin-kpi-label">{label}</span>
        </div>
    );
}

export function StatusPill({ tone, children }: StatusPillProps) {
    return <span className={'admin-pill admin-pill-' + tone}>{children}</span>;
}

function ShellBrand() {
    return (
        <div className="admin-brand">
            <img src="/branding/logo.svg" alt="" className="admin-logo" />
            <div>
                <span className="admin-wordmark">HAPPYPLACE</span>
                <span className="admin-eyebrow">Admin</span>
            </div>
        </div>
    );
}

export function Sidebar({ programName, activeSection, onNavigate, onBack }: SidebarProps) {
    return (
        <aside className="admin-sidebar">
            <ShellBrand />
            <button type="button" className="admin-back" onClick={onBack}>
                ← Programs
            </button>
            <div className="admin-prog-label">{programName}</div>
            <nav className="admin-nav">
                {PROGRAM_NAV_ITEMS.map((item) => (
                    <NavItem
                        key={item.section}
                        active={activeSection === item.section}
                        icon={NAV_ICON[item.section]}
                        label={item.label}
                        onClick={() => onNavigate(item.section)}
                    />
                ))}
            </nav>
        </aside>
    );
}

export function SidebarApp({ activeSection, onNavigate, role }: SidebarAppProps) {
    const navItems: Array<{ section: AppNavSection; label: string }> = [
        { section: 'programs', label: 'Programs' },
        { section: 'deleted', label: 'Recently deleted' },
    ];

    if (role === 'platform_admin') {
        navItems.push({ section: 'organizations', label: 'Organizations' });
        navItems.push({ section: 'users', label: 'Users' });
    } else if (role === 'org_admin') {
        navItems.push({ section: 'team', label: 'Team' });
    }

    navItems.push({ section: 'account', label: 'Account' });

    return (
        <aside className="admin-sidebar">
            <ShellBrand />
            <nav className="admin-nav">
                {navItems.map((item) => (
                    <NavItem
                        key={item.section}
                        active={activeSection === item.section}
                        label={item.label}
                        onClick={() => onNavigate(item.section)}
                    />
                ))}
            </nav>
        </aside>
    );
}

export function TopBar({ crumbs, action }: TopBarProps) {
    return (
        <header className="admin-topbar">
            <nav className="admin-breadcrumb">
                {crumbs.map((crumb, index) => (
                    <Fragment key={`${crumb}-${index}`}>
                        {index > 0 ? <span>›</span> : null}
                        <span className={index === crumbs.length - 1 ? 'is-current' : ''}>
                            {crumb}
                        </span>
                    </Fragment>
                ))}
            </nav>
            <div className="admin-topbar-action">{action}</div>
        </header>
    );
}

export function AdminLayout({ sidebar, children }: AdminLayoutProps) {
    const [navOpen, setNavOpen] = useState(false);
    const hamburgerRef = useRef<HTMLButtonElement>(null);
    const sidebarWrapRef = useRef<HTMLDivElement>(null);
    const wasOpen = useRef(false);

    useEffect(() => {
        if (!navOpen) return;

        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setNavOpen(false);
            }
        };

        document.addEventListener('keydown', onKey);

        const first = sidebarWrapRef.current?.querySelector<HTMLElement>(
            '.admin-nav-item, .admin-back, button, a',
        );
        first?.focus();

        return () => document.removeEventListener('keydown', onKey);
    }, [navOpen]);

    useEffect(() => {
        if (wasOpen.current && !navOpen) {
            hamburgerRef.current?.focus();
        }
        wasOpen.current = navOpen;
    }, [navOpen]);

    return (
        <div className={'admin-app admin-shell' + (navOpen ? ' nav-open' : '')}>
            <button
                ref={hamburgerRef}
                type="button"
                className="admin-hamburger"
                aria-label="Open navigation"
                aria-expanded={navOpen}
                onClick={() => setNavOpen((value) => !value)}
            >
                ☰
            </button>
            <div className="admin-scrim" onClick={() => setNavOpen(false)} />
            <div
                ref={sidebarWrapRef}
                className="admin-sidebar-wrap"
                onClick={(event) => {
                    if (
                        event.target instanceof Element &&
                        event.target.closest('.admin-nav-item, .admin-back')
                    ) {
                        setNavOpen(false);
                    }
                }}
            >
                {sidebar}
            </div>
            <div className="admin-main">{children}</div>
        </div>
    );
}
