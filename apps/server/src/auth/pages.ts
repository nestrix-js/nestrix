/**
 * The server-rendered pages of the admin login: the form, and the page shown while no admin
 * password is configured. No script, no inline style (CSP `LOGIN_CSP`); one stylesheet at
 * `LOGIN_CSS_PATH`. Every dynamic string is a constant chosen here, never request input.
 */
export const LOGIN_PATH = "/login";
export const LOGOUT_PATH = "/logout";
export const LOGIN_CSS_PATH = "/login.css";

export const PASSWORD_NOT_SET_MESSAGE =
  "The Nestrix dashboard and query API are disabled because NESTRIX_ADMIN_PASSWORD is not set. Set it (at least 12 characters) and restart the server. Trace ingest at /v1/traces is not affected.";

export const LOGIN_CSS = `:root{color-scheme:light dark;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:Canvas;color:CanvasText}
main{width:min(22rem,calc(100vw - 2rem))}
h1{font-size:1.25rem;margin:0 0 1.5rem}
form{display:flex;flex-direction:column;gap:.75rem}
label{font-size:.875rem}
input{font:inherit;padding:.5rem;border:1px solid GrayText;border-radius:4px;background:Field;color:FieldText}
button{font:inherit;padding:.5rem;border:1px solid CanvasText;border-radius:4px;background:CanvasText;color:Canvas;cursor:pointer}
p{font-size:.875rem;line-height:1.4;margin:0}
.error{color:#c62828}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<link rel="stylesheet" href="${LOGIN_CSS_PATH}">
</head>
<body>
<main>
<h1>Nestrix</h1>
${body}
</main>
</body>
</html>
`;
}

/** Messages the login form can show. A closed set: nothing from the request is echoed. */
export type LoginNotice =
  | "wrong-password"
  | "rate-limited"
  | "bad-origin"
  | undefined;

const NOTICES: Readonly<Record<Exclude<LoginNotice, undefined>, string>> = {
  "wrong-password": "Incorrect password.",
  "rate-limited": "Too many attempts. Wait a minute and try again.",
  "bad-origin":
    "This sign-in request did not come from this server's own page. Reload the page and try again.",
};

export function loginPage(notice: LoginNotice = undefined): string {
  const message =
    notice === undefined
      ? ""
      : `<p class="error" role="alert">${NOTICES[notice]}</p>\n`;
  return page(
    "Sign in · Nestrix",
    `<form method="post" action="${LOGIN_PATH}">
<label for="password">Admin password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
${message}<button type="submit">Sign in</button>
</form>`,
  );
}

export function passwordNotSetPage(): string {
  return page(
    "Dashboard disabled · Nestrix",
    `<p>${PASSWORD_NOT_SET_MESSAGE}</p>`,
  );
}
