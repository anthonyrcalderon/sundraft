// Admin mode = "this browser holds the admin token." The token itself is the
// secret, and the backend is what checks it (X-Admin-Token vs. the
// ADMIN_TOKEN env var on the Lambda / mock server) — so hiding the UI here
// is only convenience; someone without the token can't edit or delete a
// template no matter what they send. Nothing secret is baked into the
// frontend bundle: the token is typed in by the admin and kept in
// localStorage on that one browser.

const ADMIN_TOKEN_KEY = "sundraft_admin_token";

export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function isAdminMode(): boolean {
  return getAdminToken() !== null;
}

// Callers must have verified the token against the backend first
// (api.verifyAdminToken) — this just remembers it.
export function enableAdminMode(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function disableAdminMode(): void {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}
