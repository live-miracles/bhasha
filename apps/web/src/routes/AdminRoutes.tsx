import { Navigate, Route, Routes } from 'react-router-dom';

import { AdminScreen } from '../features/admin/AdminScreen';

export function AdminRoutes() {
    return (
        <Routes>
            <Route element={<AdminScreen />} path="/manage" />
            <Route element={<AdminScreen />} path="/manage/programs/:slug" />
            <Route element={<AdminScreen />} path="/manage/programs/:slug/:section" />
            <Route element={<Navigate replace to="/manage" />} path="/manage/*" />
        </Routes>
    );
}
