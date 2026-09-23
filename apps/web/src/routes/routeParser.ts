export type AppRoute =
    | { type: 'admin' }
    | { type: 'listener'; programSlug: string }
    | { type: 'translator'; programSlug: string }
    | { type: 'volunteer'; programSlug: string }
    | { type: 'notFound' };

export function parseRoute(pathname: string): AppRoute {
    const segments = pathname.split('/').filter((segment) => segment.length > 0);

    if (segments.length === 1 && segments[0] === 'admin') {
        return { type: 'admin' };
    }

    if (segments.length === 2 && segments[1] === 'translate') {
        const programSlug = decodeSegment(segments[0]);
        return programSlug === null ? { type: 'notFound' } : { type: 'translator', programSlug };
    }

    if (segments.length === 2 && segments[1] === 'volunteer') {
        const programSlug = decodeSegment(segments[0]);
        return programSlug === null ? { type: 'notFound' } : { type: 'volunteer', programSlug };
    }

    if (segments.length === 1) {
        const programSlug = decodeSegment(segments[0]);
        return programSlug === null ? { type: 'notFound' } : { type: 'listener', programSlug };
    }

    return { type: 'notFound' };
}

function decodeSegment(segment: string | undefined): string | null {
    if (segment === undefined) {
        return null;
    }

    try {
        return decodeURIComponent(segment);
    } catch {
        return null;
    }
}
