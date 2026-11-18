/**
 * The server-rendered pages of the admin login: the form, and the page shown while no admin
 * password is configured. No script, no inline style (CSP `LOGIN_CSP`); one stylesheet at
 * `LOGIN_CSS_PATH`. Every dynamic string is a constant chosen here, never request input.
 *
 * The look follows the dashboard's tokens (`packages/ui/app/styles.css`): the same neutral
 * palette, red for errors and amber for cautions, light and dark by `prefers-color-scheme`,
 * the same system font. The CSP allows no images or fonts, so the mark is inline SVG.
 */
export const LOGIN_PATH = "/login";
export const LOGOUT_PATH = "/logout";
export const LOGIN_CSS_PATH = "/login.css";
/** Starts an OIDC sign-in (issue #34); also the pending cookie's `Path`. */
export const OIDC_START_PATH = "/login/oidc";

export const PASSWORD_NOT_SET_MESSAGE =
  "The Nestrix dashboard and query API are disabled because NESTRIX_ADMIN_PASSWORD is not set. Set it (at least 12 characters), or configure single sign-on (NESTRIX_OIDC_ISSUER), and restart the server. Trace ingest at /v1/traces is not affected.";

export const LOGIN_CSS = `:root{color-scheme:light dark;--background:oklch(1 0 0);--foreground:oklch(.145 0 0);--card:oklch(1 0 0);--muted:oklch(.97 0 0);--muted-foreground:oklch(.45 0 0);--border:oklch(.922 0 0);--primary:oklch(.205 0 0);--primary-foreground:oklch(.985 0 0);--destructive:oklch(.577 .245 27.325);--destructive-text:oklch(.5 .21 27);--warning:oklch(.7 .16 70);--warning-text:oklch(.5 .12 65);--focus:oklch(.55 .2 260);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--background:oklch(.145 0 0);--foreground:oklch(.985 0 0);--card:oklch(.18 0 0);--muted:oklch(.269 0 0);--muted-foreground:oklch(.708 0 0);--border:oklch(1 0 0 / 10%);--primary:oklch(.922 0 0);--primary-foreground:oklch(.205 0 0);--destructive-text:oklch(.7 .19 25);--warning:oklch(.8 .15 80);--warning-text:oklch(.8 .15 80);--focus:oklch(.72 .15 255)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem;background:var(--background);color:var(--foreground);-webkit-font-smoothing:antialiased}
main{width:min(24rem,100%);background:var(--card);border:1px solid var(--border);border-radius:.75rem;padding:2rem 1.75rem;box-shadow:0 1px 2px oklch(0 0 0 / 6%),0 8px 24px oklch(0 0 0 / 6%)}
.brand{display:flex;align-items:center;gap:.625rem;margin:0 0 1.5rem}
.mark{width:2rem;height:2rem;flex:none;padding:.4rem;border-radius:.5rem;background:var(--primary);color:var(--primary-foreground)}
h1{font-size:1.125rem;font-weight:600;letter-spacing:-.01em;margin:0}
h2{font-size:1.25rem;font-weight:600;letter-spacing:-.01em;margin:0 0 .25rem}
.lead{margin:0 0 1.25rem;color:var(--muted-foreground)}
form{display:flex;flex-direction:column;gap:.75rem}
label{font-size:.8125rem;font-weight:500}
input{font:inherit;font-size:.875rem;width:100%;height:2.25rem;padding:0 .75rem;border:1px solid var(--border);border-radius:.5rem;background:var(--background);color:var(--foreground)}
input:focus-visible,button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button{font:inherit;font-size:.875rem;font-weight:500;height:2.25rem;padding:0 .75rem;border:1px solid var(--primary);border-radius:.5rem;background:var(--primary);color:var(--primary-foreground);cursor:pointer}
button:hover,a.button:hover{opacity:.9}
a.button{display:flex;align-items:center;justify-content:center;font-size:.875rem;font-weight:500;height:2.25rem;padding:0 .75rem;border:1px solid var(--primary);border-radius:.5rem;background:var(--primary);color:var(--primary-foreground);text-decoration:none}
a.button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.or{display:flex;align-items:center;gap:.5rem;margin:1rem 0;font-size:.75rem;color:var(--muted-foreground)}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--border)}
.secondary{background:transparent;color:var(--foreground);border-color:var(--border)}
p{font-size:.875rem;line-height:1.5;margin:0}
.notice{display:flex;gap:.5rem;align-items:flex-start;padding:.625rem .75rem;border-radius:.5rem;border:1px solid var(--destructive);background:oklch(.577 .245 27.325 / 8%);color:var(--destructive-text)}
.notice.caution{border-color:var(--warning);background:oklch(.7 .16 70 / 10%);color:var(--foreground)}
.notice svg{width:1rem;height:1rem;flex:none;margin-top:.15rem}
.notice.caution svg{color:var(--warning-text)}
.hint{margin-top:1.25rem;font-size:.75rem;color:var(--muted-foreground)}
`;

const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2" y="4" width="14" height="4" rx="1.5" fill="currentColor"/><rect x="7" y="10" width="15" height="4" rx="1.5" fill="currentColor" opacity=".75"/><rect x="4" y="16" width="9" height="4" rx="1.5" fill="currentColor" opacity=".5"/></svg>`;

const ALERT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;

function page(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<link rel="stylesheet" href="${LOGIN_CSS_PATH}">
${head}</head>
<body>
<main>
<div class="brand">${MARK}<h1>Nestrix</h1></div>
${body}
</main>
</body>
</html>
`;
}

/** Messages the login form can show. A closed set: nothing from the request is echoed. */
export type LoginNotice =
  | "wrong-password"
  | "password-disabled"
  | "sso-failed"
  | "sso-not-allowed"
  | "sso-unavailable"
  | "rate-limited"
  | "bad-origin"
  | "unavailable"
  | undefined;

const NOTICES: Readonly<Record<Exclude<LoginNotice, undefined>, string>> = {
  "wrong-password": "Incorrect password.",
  "password-disabled":
    "Signing in with the admin password is turned off on this server. Use single sign-on.",
  "sso-failed":
    "Single sign-on did not complete. Start again; if it keeps failing, ask the server's operator to check its log.",
  "sso-not-allowed":
    "Your account signed in, but it is not in a group that may open this dashboard. Ask an admin.",
  "sso-unavailable":
    "Single sign-on is unavailable: the identity provider cannot be reached. Try again shortly.",
  "rate-limited": "Too many attempts. Wait a minute and try again.",
  unavailable:
    "Signing in is unavailable: the server cannot reach its database. Try again shortly.",
  "bad-origin":
    "This sign-in request did not come from this server's own page. Reload the page and try again.",
};

/** Which ways of signing in the form offers. */
export interface LoginOptions {
  /** The admin password (break-glass when OIDC is on). */
  readonly password: boolean;
  /** Single sign-on: a link to `/login/oidc` (a link, not a form: the CSP's `form-action` would
   * block the redirect to the identity provider). */
  readonly oidc: boolean;
}

export function loginPage(
  notice: LoginNotice = undefined,
  options: LoginOptions = { password: true, oidc: false },
): string {
  const message =
    notice === undefined
      ? ""
      : `<p class="notice" role="alert">${ALERT_ICON}<span>${NOTICES[notice]}</span></p>\n`;
  const sso = options.oidc
    ? `<a class="button" href="${OIDC_START_PATH}">Sign in with single sign-on</a>\n`
    : "";
  const password = options.password
    ? `<form method="post" action="${LOGIN_PATH}">
<label for="password">${options.oidc ? "Break-glass admin password" : "Admin password"}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required${options.oidc ? "" : " autofocus"}>
${options.oidc ? "" : message}<button type="submit"${options.oidc ? ' class="secondary"' : ""}>Sign in${options.oidc ? " with the password" : ""}</button>
</form>`
    : "";
  const lead = options.oidc
    ? "Sign in with your organisation's account to open the dashboard."
    : "Enter the admin password to open the dashboard.";
  return page(
    "Sign in · Nestrix",
    `<h2>Sign in</h2>
<p class="lead">${lead}</p>
${options.oidc ? message : ""}${sso}${options.oidc && options.password ? '<p class="or">or</p>\n' : ""}${password}${!options.oidc && !options.password ? message : ""}`,
  );
}

/**
 * Shown after a successful single sign-on: continues to `/` with a same-origin navigation (meta
 * refresh), so the browser sends the new `SameSite=Strict` cookie; a redirect from the callback
 * would still count as the identity provider's cross-site navigation.
 */
export function signedInPage(): string {
  return page(
    "Signed in · Nestrix",
    `<h2>Signed in</h2>
<p class="lead">Opening the dashboard…</p>
<a class="button" href="/">Continue</a>`,
    '<meta http-equiv="refresh" content="0;url=/">\n',
  );
}

export function passwordNotSetPage(): string {
  return page(
    "Dashboard disabled · Nestrix",
    `<h2>Dashboard disabled</h2>
<p class="notice caution">${ALERT_ICON}<span>${PASSWORD_NOT_SET_MESSAGE}</span></p>`,
  );
}
