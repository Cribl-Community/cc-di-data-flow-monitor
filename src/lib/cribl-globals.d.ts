// Platform globals injected by the Cribl Apps runtime. Read-only, always present when running
// inside Cribl — never define, assign, or polyfill these. See AGENTS.md.

export interface CriblUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  initials?: string;
}

declare global {
  interface Window {
    /** Base URL for all Cribl API calls, e.g. `https://localhost:9000/api/v1`. */
    readonly CRIBL_API_URL: string;
    /** The base path this app is mounted at, e.g. `/app-ui/my-app`. */
    readonly CRIBL_BASE_PATH: string;
    /** The app's own id, as scoped by the platform (dev mode prefixes with `__dev__`). */
    readonly CRIBL_APP_ID?: string;
    /** Resolves to the signed-in user's identity/profile info. Memoized by the platform. */
    getCriblUser(): Promise<CriblUser>;
  }
}
