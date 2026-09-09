/**
 * Talks to cainsat.org, which holds the account and the data.
 *
 * The planner is static files with no backend of its own. It used to run a
 * separate Firebase project with separate accounts, so a student needed two
 * logins for one site. Now both halves share the cainsat.org session: the
 * cookie is scoped to .cainsat.org, and because tasks.cainsat.org sits under
 * the same registrable domain the browser still counts it as same-site and
 * sends the cookie on these calls. They are cross-origin, so every request
 * needs credentials: "include" and the API needs matching CORS headers.
 */

/**
 * The www host, not the apex. cainsat.org 308-redirects to www.cainsat.org, and
 * a CORS preflight that meets a redirect is a network error rather than
 * something the browser follows -- so every PUT from here would fail against the
 * apex, while the GETs quietly took an extra hop. This must stay whichever host
 * actually serves the app.
 */
export const API_BASE = (() => {
  const host = location.hostname;
  if (host.endsWith("cainsat.org")) return "https://www.cainsat.org";
  // Local development: `next dev` on 3000, planner on Live Server.
  // Use http://localhost:5500, not 127.0.0.1 -- the session cookie is
  // same-site with localhost:3000 but cross-site with 127.0.0.1.
  return "http://localhost:3000";
})();

/** Where to send someone who is not signed in. */
export function loginUrl(returnTo = location.href) {
  return `${API_BASE}/auth/login?callbackUrl=${encodeURIComponent(returnTo)}`;
}

/** Top-level navigation, not fetch: NextAuth's sign-out page is not CORS-enabled. */
export function signOutUrl(returnTo = location.href) {
  return `${API_BASE}/api/auth/signout?callbackUrl=${encodeURIComponent(returnTo)}`;
}

async function call(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...options,
  });
  if (res.status === 401) {
    const err = new Error("Not signed in");
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) throw new Error(`${options.method || "GET"} ${path} failed: ${res.status}`);
  return res.json();
}

/**
 * The signed-in user, or null. Never throws for "signed out" -- that is a
 * normal answer, and only a genuine network or server failure should reject.
 */
export async function getSession() {
  const data = await call("/api/planner/session");
  return data.user;
}

/** Task list, view preferences and pomodoro in one round trip. */
export function loadPlanner() {
  return call("/api/planner");
}

export function saveTasksRemote(tasks) {
  return call("/api/planner/tasks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tasks }),
  });
}

export function saveSettingsRemote(payload) {
  return call("/api/planner/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Coalesces rapid changes into one request, and guarantees the last value wins.
 *
 * Typing a task name fires a save per keystroke and the pomodoro used to fire
 * one per second; both went straight to the database. Saves are queued here
 * instead: while one is in flight, later calls collapse into a single follow-up
 * carrying the newest payload.
 */
export function makeDebouncedSaver(send, waitMs = 800) {
  let timer = null;
  let pending = null;
  let inFlight = false;
  let lastError = null;

  async function flushNow() {
    if (inFlight || pending === null) return;
    const payload = pending;
    pending = null;
    inFlight = true;
    let failed = false;
    try {
      await send(payload);
      lastError = null;
    } catch (err) {
      lastError = err;
      failed = true;
      // Put the payload back. Without this it is simply dropped: `pending` was
      // cleared before the await, so a later Retry hits the `pending === null`
      // guard above, returns without sending anything, and leaves the banner
      // hidden -- which reads as "saved" when the changes were in fact lost.
      // A newer edit that arrived mid-flight supersedes this one and is kept.
      if (pending === null) pending = payload;
      if (saver.onError) saver.onError(err);
    } finally {
      inFlight = false;
      // Only chase a follow-up after a success. Re-entering on the failure path
      // would immediately resend what was just requeued, and keep doing so.
      if (!failed && pending !== null) flushNow();
    }
  }

  function saver(payload) {
    pending = payload;
    clearTimeout(timer);
    timer = setTimeout(flushNow, waitMs);
  }

  /** Send immediately, e.g. before the page unloads. */
  saver.flush = () => {
    clearTimeout(timer);
    return flushNow();
  };
  saver.hasPending = () => pending !== null || inFlight;
  saver.lastError = () => lastError;
  saver.onError = null;

  return saver;
}
