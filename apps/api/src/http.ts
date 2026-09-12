export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return Response.json(data, { ...init, headers });
}

export function notFound(): Response {
  return json({ error: "not_found" }, { status: 404 });
}

export async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}
