import { useEffect, useMemo, useState, type FormEvent } from "react";

import { ApiError } from "../../api/client";
import { type AdminApi, type AdminOrg } from "../../api/admin";

interface OrgsPanelProps {
  adminApi: Pick<AdminApi, "listOrgs" | "createOrg" | "updateOrg">;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (
      error.status === 409 &&
      error.body != null &&
      typeof error.body === "object" &&
      "error" in error.body &&
      typeof error.body.error === "string"
    ) {
      if (error.body.error === "email_taken") {
        return "Admin email is already in use.";
      }
    }
    if (typeof error.body === "object" && error.body !== null && "message" in error.body) {
      const bodyMessage = (error.body as { message?: string }).message;
      if (typeof bodyMessage === "string" && bodyMessage.trim() !== "") {
        return bodyMessage;
      }
    }
    return error.code;
  }
  return String(error);
}

export function OrgsPanel({ adminApi }: OrgsPanelProps) {
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [editingOrgId, setEditingOrgId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [form, setForm] = useState({
    orgName: "",
    email: "",
    tempPassword: ""
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await adminApi.listOrgs();
        if (!cancelled) {
          setOrgs(response.orgs);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(errorText(loadError));
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [adminApi]);

  const hasOrgs = useMemo(() => orgs.length > 0, [orgs]);

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const created = await adminApi.createOrg(form);
      setOrgs((previous) => [...previous, created.org]);
      setForm({ orgName: "", email: "", tempPassword: "" });
    } catch (createError) {
      setError(errorText(createError));
    } finally {
      setPending(false);
    }
  }

  async function submitRename(orgId: string, nextName: string) {
    if (!nextName.trim()) {
      return;
    }
    setError(null);
    setSavingId(orgId);
    try {
      const updated = await adminApi.updateOrg(orgId, { name: nextName.trim() });
      setOrgs((previous) => previous.map((org) => (org.id === updated.id ? updated : org)));
      setEditingOrgId(null);
      setEditName("");
    } catch (renameError) {
      setError(errorText(renameError));
    } finally {
      setSavingId(null);
    }
  }

  function startRename(org: AdminOrg) {
    setEditingOrgId(org.id);
    setEditName(org.name);
    setError(null);
  }

  function cancelRename() {
    setEditingOrgId(null);
    setEditName("");
  }

  return (
    <section aria-label="Organizations" className="admin-section">
      <div className="admin-section-head">
        <h2>Organizations</h2>
      </div>

      <article className="admin-card">
        <h2>Create organization</h2>
        <form className="admin-form" onSubmit={submitCreate}>
          <label>
            Organization name
            <input
              onChange={(event) =>
                setForm({ ...form, orgName: event.target.value })
              }
              required
              value={form.orgName}
            />
          </label>
          <label>
            Admin email
            <input
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              required
              type="email"
              value={form.email}
            />
          </label>
          <label>
            Temp password
            <input
              onChange={(event) =>
                setForm({ ...form, tempPassword: event.target.value })
              }
              required
              type="password"
              value={form.tempPassword}
            />
          </label>
          <button disabled={pending} type="submit">
            Create organization
          </button>
        </form>
      </article>

      {error ? <p className="admin-alert" role="alert">{error}</p> : null}

      {hasOrgs ? null : <p>No organizations yet.</p>}
      {orgs.length > 0 ? (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Organization</th>
              <th>Admin actions</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => (
              <tr key={org.id}>
                <td>
                  {editingOrgId === org.id ? (
                    <div className="admin-inline-form">
                      <label>
                        Name
                        <input
                          autoComplete="off"
                          onChange={(event) => setEditName(event.target.value)}
                          value={editName}
                        />
                      </label>
                    </div>
                  ) : (
                    org.name
                  )}
                </td>
                <td>
                  {editingOrgId === org.id ? (
                    <>
                      <button
                        onClick={() => submitRename(org.id, editName)}
                        type="button"
                        disabled={savingId === org.id}
                      >
                        Save
                      </button>
                      <button onClick={cancelRename} type="button">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button onClick={() => startRename(org)} type="button">
                      Rename
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
