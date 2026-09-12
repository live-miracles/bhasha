# Web App

Slice 4 adds the Vite app shell and same-origin API client only.

For split local development, run the API worker on `http://127.0.0.1:8787`
and start the web dev server with `npm run dev --workspace apps/web`. The Vite
dev server proxies `/api/*` to the worker, while application code continues to
call relative `/api/*` URLs. The Cloudflare Pages Worker/assets bridge remains
deployment work for a later slice.
