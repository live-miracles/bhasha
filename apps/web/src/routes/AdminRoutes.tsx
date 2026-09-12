import { Navigate, Route, Routes } from "react-router-dom";

import { AdminScreen } from "../features/admin/AdminScreen";

export function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminScreen />} path="/admin" />
      <Route element={<AdminScreen />} path="/admin/programs/:slug" />
      <Route element={<AdminScreen />} path="/admin/programs/:slug/:section" />
      <Route element={<Navigate replace to="/admin" />} path="/admin/*" />
    </Routes>
  );
}
