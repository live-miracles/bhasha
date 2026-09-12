import { BrowserRouter } from "react-router-dom";

import { createPublicApi, type PublicApi } from "./api/public";
import { AdminRoute } from "./routes/AdminRoute";
import { AdminRoutes } from "./routes/AdminRoutes";
import { ListenerRoute } from "./routes/ListenerRoute";
import { NotFoundRoute } from "./routes/NotFoundRoute";
import { TranslatorRoute } from "./routes/TranslatorRoute";
import { VolunteerRoute } from "./routes/VolunteerRoute";
import { parseRoute } from "./routes/routeParser";

export interface AppProps {
  path?: string;
  publicApi?: PublicApi;
}

export function App({ path, publicApi = createPublicApi() }: AppProps) {
  const currentPath = path ?? window.location.pathname;
  if (currentPath === "/admin" || currentPath.startsWith("/admin/")) {
    return (
      <BrowserRouter>
        <AdminRoutes />
      </BrowserRouter>
    );
  }

  const route = parseRoute(path ?? window.location.pathname);

  switch (route.type) {
    case "admin":
      return <AdminRoute />;
    case "listener":
      return (
        <ListenerRoute programSlug={route.programSlug} publicApi={publicApi} />
      );
    case "translator":
      return <TranslatorRoute programSlug={route.programSlug} publicApi={publicApi} />;
    case "volunteer":
      return <VolunteerRoute programSlug={route.programSlug} publicApi={publicApi} />;
    case "notFound":
      return <NotFoundRoute />;
  }
}
