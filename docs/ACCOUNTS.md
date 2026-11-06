# Portal accounts: sign-in, two-factor, approval

Turned on by two lines in the backend `.env`:

```
SUPERUSER_EMAIL=vikram.sethi@onesmarter.com      # one or more, comma-separated
AUTH_SECRET=<long random string>                  # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Restart the backend. From then on every `/api` route needs a signed-in session. `API_TOKEN`, if set, still works as a
service token for scripts and Claude Desktop. Without `SUPERUSER_EMAIL` nothing changes: the old token gate (or open
access) stays.

## Flow

1. **Register** (`#register`): full name, work email, password (12+ characters), confirm. The request is *pending*.
   An address listed in `SUPERUSER_EMAIL` comes out *active* and *admin* at once.
2. **Approve**: an admin opens **Users** in the left rail (badge shows how many are waiting), picks Member or Admin,
   presses Approve or Reject. Recorded in the audit table with the admin's name.
3. **First sign-in**: email + password, then a QR code to scan in Google Authenticator, Microsoft Authenticator or
   1Password, one six-digit code to confirm, and ten recovery codes shown once. Two-factor cannot be skipped.
4. **Every sign-in**: email + password + six-digit code (or a recovery code, once each). Five wrong passwords lock
   the account for 15 minutes. Errors never say which part was wrong.
5. **Inside**: the rail shows the person's name and Sign out. Members see every page except Users; admins see Users too.
   Approve/reject of drafts, searches, runs, campaign and automation changes carry the person's name in the audit trail.
6. **Leaving**: Sign out ends the session. An admin can Disable someone (signed out at once) or Enable them again.
   A superuser cannot be disabled, rejected or demoted from the portal; change `.env` for that.

## Where things are

| | |
|---|---|
| Accounts, sessions, recovery codes, audit | `data/users.sqlite` (git-ignored). Back it up with the rest of `data/` |
| Session | HttpOnly `outreach_session` cookie, 12 h idle, 7 days at most. Set `COOKIE_SECURE=true` once served over HTTPS |
| Two-factor secrets | Encrypted with `AUTH_SECRET`. Changing `AUTH_SECRET` makes every authenticator useless: people would have to enrol again |
| Code | `src/api/auth/` (crypto, store, routes); pages in the frontend under `src/pages/auth/` and `src/pages/UsersPage.tsx` |

## Emails (optional)

Add to `.env` and restart:

```
SMTP_HOST=smtp.ionos.com
SMTP_PORT=587                       # 465 = TLS, 587 = STARTTLS
SMTP_USER=akshay.kumar@onesmarter.com
SMTP_PASS=<password>
MAIL_FROM="OneSmarter Support <support@onesmarter.com>"
MAIL_REPLY_TO=help@onesmarter.com
ADMIN_NOTIFY=vikram.sethi@onesmarter.com      # who hears about new requests; empty = every active admin
PORTAL_URL=http://localhost:5173               # used for the links in the mails
```

Then: a new request mails `ADMIN_NOTIFY` with a link to Users; Approve mails the person a sign-in link; Reject mails a
short note with the reason; "Forgot password?" on the sign-in page mails a single-use link good for 30 minutes (the answer
on screen is the same whether or not the address exists); setting a new password signs out every session. The Users page
shows "Email on/off" and has **Send me a test email** for admins. Every mail sent or failed is in the audit list, so a lost
mail is visible. A mail problem never blocks register or approve. Use a mailbox different from the one AutoBooker sends
outreach from.

## Lost phone

Sign in with a recovery code, then ask an admin to disable and re-enable the account; the next sign-in enrols a new
authenticator. (A self-service "reset two-factor" button is a later addition.)

## Hosting

Sessions are cookies, so the portal must be served from one origin: in development Vite proxies `/api` to the
backend; in production the backend serves the built frontend. Behind HTTPS set `COOKIE_SECURE=true`.
