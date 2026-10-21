// The accounts the UI tests sign in as. They exist only in a test database
// (_e2e or _test): global-setup.ts recreates them on every run, behind the
// same guard the integration suite uses.
export const E2E_USER = { username: "e2e_user", password: "e2e-user-password", role: "user" } as const;
export const E2E_ADMIN = { username: "e2e_admin", password: "e2e-admin-password", role: "admin" } as const;
