# UI Redesign And Frontend Architecture Action Plan

Status: Phase 1 and the first Phase 2/3 slice implemented; remaining phases pending

## Decision

Rebuild the frontend around one React/Vite/TypeScript application with:

- Mantine as the shared component system and theme layer.
- TanStack Query for API/server state, cache invalidation, and polling.
- React Router as the single routing system for admin, listener, translator, and
  volunteer routes.
- The existing Hono API contracts and LiveKit realtime clients kept behind the
  existing API and realtime modules.

Do not add Tailwind, daisyUI, Refine, MUI, or a second UI framework. The goal is
to reuse a complete, accessible component system rather than recreate buttons,
forms, cards, navigation, dialogs, tables, alerts, and responsive layout in
local CSS.

## Why this fits Bhasha

The current application is already React + Vite + TypeScript. The main frontend
problem is composition, not the rendering technology:

- `AdminScreen.tsx` combines authentication, navigation, API loading, polling,
  forms, dialogs, reports, readiness, QR generation, and rendering.
- `styles.css` contains a large custom admin design system in addition to the
  listener and translator styles.
- The admin dashboard needs tables, forms, navigation, dialogs, status badges,
  reports, and responsive layouts.
- The listener and translator experiences need different product-specific
  layouts, but can share typography, spacing, surfaces, status colors, and
  accessible controls.
- The product is still draft-stage, so visual replacement is acceptable. The
  important compatibility boundary is behavior: public URLs, API contracts,
  LiveKit permissions, listener receive-only behavior, and translator publish
  behavior must remain intact.

## Target architecture

```text
apps/web/src/
  app/
    providers.tsx       Mantine, notifications, TanStack Query
    router.tsx          one React Router tree for every surface
  shared/
    theme/
      theme.ts          Bhasha theme and semantic state colors
    components/         only genuinely shared UI primitives
  features/
    admin/
      pages/             route-level dashboard pages
      components/        admin-specific compositions
      queries/           TanStack Query hooks and query keys
      forms/             create/edit form models and validation
    listener/
      components/
      hooks/
    translator/
      components/
      hooks/
    volunteer/
  api/                    existing typed HTTP clients remain here
  realtime/               existing LiveKit clients remain here
```

Feature components may use Mantine directly. The `shared/components` directory
should stay small and contain only patterns used by at least two surfaces, such
as `StatusBadge`, `LoadingState`, `ErrorState`, `EmptyState`, and `PageHeader`.

## State and data rules

Use TanStack Query for server state:

- authenticated admin identity
- program lists and deleted programs
- program detail
- live stream status
- readiness
- listener reports and event feeds
- translator sessions
- volunteer access

Use local React state or reducers for transient UI state:

- form drafts
- open dialogs and drawers
- selected filters before submission
- expanded rows/cards
- local audio/realtime state

Use query invalidation after mutations. Poll only data that represents live
operational state, with explicit intervals and cancellation when the page is
hidden or unmounted. Do not move LiveKit connection state into TanStack Query.

## Route model

Preserve these public URLs:

- `/`
- `/manage`
- `/manage/programs/:slug`
- `/manage/programs/:slug/:section`
- `/:programSlug`
- `/:programSlug/translate`
- `/:programSlug/volunteer`

Move the current custom public route parsing and the admin-only BrowserRouter to
one application-level React Router tree. Keep route behavior and not-found
behavior covered by existing tests while making route ownership explicit.

## UI redesign scope

### Admin

Create a responsive Mantine `AppShell` with:

- persistent desktop navigation and mobile navigation drawer
- program list and recently deleted views
- account/users views according to role
- program-scoped navigation for overview, status, streams, translators, share,
  readiness, and reports
- a consistent page header, breadcrumb, action area, and loading/error states

Rebuild the admin pages with Mantine primitives rather than translating every
existing CSS selector one-for-one. Keep the existing API behavior for:

- program CRUD/archive/restore
- stream CRUD and active state
- translator CRUD, assignments, sessions, and password reset
- QR and URL sharing
- readiness confirmations
- listener access controls
- reports, event feeds, filters, pagination, and CSV download
- publisher/session kick actions

### Listener

Keep the listener interaction model intentionally simple and mobile-first:

- no microphone or camera permission
- large language choices
- clear live/paused/offline state
- one-tap audio start after a user gesture
- visible reconnect and enable-sound actions
- volume control that works on mobile
- no operational listener counts

Mantine can supply layout, cards, buttons, badges, and typography, but the
language tile and playback state presentation remain product-specific.

### Translator

Keep the translator as a focused audio console:

- microphone-only permission
- assigned-language context
- explicit go-live, mute/unmute, reconnect, and stop actions
- clear connecting, live, muted, silent, stopped, and error states
- visible microphone activity meter
- mobile-friendly audio settings

Mantine can supply layout, buttons, cards, drawers, alerts, and progress
components. Do not alter the existing publish state machine or LiveKit token
permissions as part of the visual migration.

## Implementation phases

### Phase 1: Foundation

- Add Mantine packages and TanStack Query.
- Add the application providers and Bhasha theme.
- Add the one application-level router without changing public URLs.
- Establish global typography, background, spacing, focus, and status tokens.
- Add a small set of shared loading/error/empty/status primitives.
- Add or update tests for providers and route coverage.

Implementation status: complete for the current slice. Mantine, notifications,
TanStack Query's provider, the theme, and the shared test `matchMedia` seam are
in place. The application now has one React Router tree while preserving the
existing public paths.

### Phase 2: Admin shell and navigation

- Replace the current admin shell/sidebar/top bar with Mantine `AppShell`.
- Add responsive mobile navigation and accessible drawer behavior.
- Split authentication, shell, program list, and program detail concerns.
- Preserve role-based navigation and URL section mapping.

Implementation status: the responsive Mantine `AppShell`, mobile Burger
navigation, Mantine navigation links, breadcrumbs, KPI tiles, status badges,
and program cards/forms are implemented. The remaining admin pages still use
the legacy rendering while they are migrated page by page.

### Phase 3: Admin pages and queries

- Extract admin query keys and hooks.
- Rebuild overview, streams, translators, share, readiness, and reports pages.
- Convert mutations to query invalidation.
- Preserve report filtering/pagination and operational polling semantics.
- Remove obsolete admin CSS after each page is migrated.

Implementation status: Mantine has been introduced into the create-program,
program-list, KPI, and shell surfaces. TanStack Query is installed and provided
but the existing admin fetch orchestration remains to be extracted in the next
slice.

### Phase 4: Listener and translator migration

- Move both surfaces onto the shared theme and Mantine primitives.
- Preserve their mobile-first interaction and audio-specific state behavior.
- Keep realtime clients and permission boundaries unchanged.
- Update component tests and Playwright coverage for mobile-relevant flows.

### Phase 5: Cleanup and verification

- Remove dead CSS, dead components, and duplicate layout helpers.
- Confirm no remaining admin-only global selectors are required.
- Run formatting, lint, typecheck, Vitest, and Playwright.
- Review the final diff for accidental API, route, auth, or LiveKit changes.

## Test-first requirements

For each implementation slice:

1. Add or update a focused failing test.
2. Implement the smallest change that makes it pass.
3. Run the relevant Vitest suite.
4. Run web typecheck.
5. Run the full web test suite before completing the slice.

Important regression cases:

- listener clients never request or publish microphone/camera tracks
- translator clients retain microphone publishing behavior
- public and translator URLs remain unchanged
- admin roles retain their correct navigation and permissions
- admin mutations refresh the correct data
- live status/session polling stops when no longer needed
- mobile navigation, reconnect, and user-gesture audio behavior remain usable

## Acceptance criteria

- The app builds with one coherent Mantine theme and no second UI framework.
- Admin pages are route/page/component separated; `AdminScreen.tsx` is no longer
  the owner of every admin concern.
- API data fetching and polling are query-driven and invalidated after mutations.
- Existing API contracts, LiveKit clients, auth behavior, and public URLs remain
  compatible.
- The listener remains receive-only and mobile-first.
- The translator remains microphone-only and operationally clear.
- Existing tests pass, new architectural tests cover providers/routes/query
  behavior, and Playwright covers the redesigned critical flows.

## Verification commands

```bash
npm run format:check
npm run lint
npm run typecheck
npm test --workspace apps/web
npm run e2e --workspace apps/web
```

The implementation should not commit changes. Git history and the final commit
remain under the top-level orchestrator's control.
