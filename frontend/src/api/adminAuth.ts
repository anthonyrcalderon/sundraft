// Admin mode gates the UI only — it's a speed bump against casually
// stumbling into template-editing controls, not real security. The backend's
// own check (see infra/lambda/projects.ts and mock-server/server.ts) is just
// "does this request carry an X-Admin: true header," which anyone could set
// directly with curl/devtools regardless of what this file does. A real
// auth story (Cognito, signed tokens, etc.) is out of scope for a portfolio
// demo with no sensitive data behind it — worst case here is someone
// vandalizes an example template, which is just re-created.

const ADMIN_STORAGE_KEY = "sundraft_admin";

export function isAdminMode(): boolean {
  return localStorage.getItem(ADMIN_STORAGE_KEY) === "true";
}

// Returns whether admin mode ended up enabled, so callers can react (e.g.
// show an error) without re-reading storage themselves.
export function tryEnableAdminMode(password: string): boolean {
  const expected = import.meta.env.VITE_ADMIN_PASSWORD as string | undefined;
  if (!expected || password !== expected) return false;
  localStorage.setItem(ADMIN_STORAGE_KEY, "true");
  return true;
}

export function disableAdminMode(): void {
  localStorage.removeItem(ADMIN_STORAGE_KEY);
}
