import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';

import { AppProviders } from './app/providers';
import { createPublicApi, type PublicApi } from './api/public';
import { AdminScreen } from './features/admin/AdminScreen';
import { LandingRoute } from './routes/LandingRoute';
import { ListenerRoute } from './routes/ListenerRoute';
import { TranslatorRoute } from './routes/TranslatorRoute';
import { ApproverRoute } from './routes/ApproverRoute';
import { NotFoundRoute } from './routes/NotFoundRoute';

export interface AppProps {
    path?: string;
    publicApi?: PublicApi;
}

function RoutedListener({ publicApi }: { publicApi: PublicApi }) {
    const { programSlug } = useParams<{ programSlug: string }>();
    return <ListenerRoute programSlug={programSlug ?? ''} publicApi={publicApi} />;
}

function RoutedTranslator({ publicApi }: { publicApi: PublicApi }) {
    const { programSlug } = useParams<{ programSlug: string }>();
    return <TranslatorRoute programSlug={programSlug ?? ''} publicApi={publicApi} />;
}

function RoutedApprover({ publicApi }: { publicApi: PublicApi }) {
    const { programSlug } = useParams<{ programSlug: string }>();
    return <ApproverRoute programSlug={programSlug ?? ''} publicApi={publicApi} />;
}

function AppRoutes({ publicApi }: { publicApi: PublicApi }) {
    return (
        <Routes>
            <Route element={<LandingRoute />} path="/" />
            <Route element={<AdminScreen />} path="/manage" />
            <Route element={<AdminScreen />} path="/manage/programs/:slug" />
            <Route element={<AdminScreen />} path="/manage/programs/:slug/:section" />
            <Route element={<Navigate replace to="/manage" />} path="/manage/*" />
            <Route element={<NotFoundRoute />} path="/admin" />
            <Route
                element={<RoutedTranslator publicApi={publicApi} />}
                path="/:programSlug/translate"
            />
            <Route
                element={<RoutedApprover publicApi={publicApi} />}
                path="/:programSlug/approver"
            />
            <Route element={<RoutedListener publicApi={publicApi} />} path="/:programSlug" />
            <Route element={<NotFoundRoute />} path="*" />
        </Routes>
    );
}

export function App({ path, publicApi = createPublicApi() }: AppProps) {
    const router =
        path === undefined ? (
            <BrowserRouter>
                <AppRoutes publicApi={publicApi} />
            </BrowserRouter>
        ) : (
            <MemoryRouter initialEntries={[path]}>
                <AppRoutes publicApi={publicApi} />
            </MemoryRouter>
        );

    return <AppProviders>{router}</AppProviders>;
}
