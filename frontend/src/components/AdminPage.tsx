import { useEffect, useState, type FormEvent } from "react";
import { api, type Project } from "../api/client";
import { disableAdminMode, enableAdminMode, getAdminToken } from "../api/adminAuth";
import ProjectPicker from "./ProjectPicker";

interface Props {
  onOpen: (project: Project) => void;
  onExit: () => void;
}

// Lives at /admin and isn't linked from anywhere. Asks for the admin token,
// has the backend confirm it, and only then shows the picker with its edit
// controls. The check that actually matters is server-side on every write —
// this gate just keeps the controls out of the public page.
export default function AdminPage({ onOpen, onExit }: Props) {
  const [state, setState] = useState<"checking" | "in" | "out">(
    getAdminToken() ? "checking" : "out"
  );
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A token from an earlier visit may have been rotated since — confirm it
  // still works before showing admin controls that would just 403.
  useEffect(() => {
    const saved = getAdminToken();
    if (!saved) return;
    api
      .verifyAdminToken(saved)
      .then(() => setState("in"))
      .catch(() => {
        disableAdminMode();
        setState("out");
      });
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.verifyAdminToken(token);
      enableAdminMode(token);
      setState("in");
    } catch {
      setError("That token wasn't accepted.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleExit() {
    disableAdminMode();
    onExit();
  }

  if (state === "checking") {
    return (
      <div className="app app--centered">
        <span className="spinner spinner--large" />
      </div>
    );
  }

  if (state === "in") {
    return <ProjectPicker onOpen={onOpen} adminMode onExitAdmin={handleExit} />;
  }

  return (
    <div className="app admin-login">
      <h1>Admin</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Admin token"
          autoComplete="current-password"
          autoFocus
        />{" "}
        <button className="primary-button" type="submit" disabled={submitting || !token}>
          {submitting ? "Checking…" : "Sign in"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <p>
        <button className="link" onClick={onExit}>
          ← Back to SunDraft
        </button>
      </p>
    </div>
  );
}
