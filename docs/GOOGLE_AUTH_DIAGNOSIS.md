# Google authorization diagnosis — 2026-09-22

## Verified findings

- Original and isolated setups use the same `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, tenant and token encryption key. Values are not recorded.
  The original configuration comes from the working checkout's `.env`; the isolated
  setup has a private environment file and separate SQLite token store.
- The isolated refresh token saved September 15 returned HTTP 400 `invalid_grant`:
  Google said "Token has been expired or revoked." This does not distinguish
  expiration from revocation. Both stored access tokens had expired normally.
- The newer original refresh token saved September 21 returned HTTP 200. Its valid
  authorization was restored in the isolated database only. The original database,
  environment, running phone service and routing were not changed.
- The isolated authorization request returned Google's explicit HTTP-400 error page
  `redirect_uri_mismatch` for `http://localhost:3101/api/integrations/google/callback`.
  The original app is configured for port 3000. The Cloud console remains blocked
  by required 2-step verification; the project/client display name, registered URI
  list and consent-screen publishing status could not be inspected.
- Restored authorization exposed a separate access-check bug: Google calendar
  metadata returned HTTP 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, while an events
  access probe on the same calendar returned HTTP 200. The app requests
  `calendar.events` and `calendar.events.freebusy`; calendar metadata requires a
  different scope. Verification now uses events with `maxResults=1&fields=kind`,
  avoiding event details and additional permissions. Scheduling operations unchanged.
- The restarted isolated API reports the default calendar `accessible`. Both
  original and isolated `/api/health` endpoints return HTTP 200. No real events
  were created, changed or deleted. Read access does not prove event write access.

## Operator steps

1. Open Google Cloud Console and click **Turn on 2-step verification**. Complete
   Google's account-security steps personally, then refresh the console.
2. Select the project containing the OAuth client matching `GOOGLE_CLIENT_ID` in
   the local configuration. Do not paste any credentials into chat.
3. Open **Google Auth Platform → Clients** (or **APIs & Services → Credentials**)
   and edit that existing OAuth web client.
4. Under **Authorized redirect URIs**, add exactly:
   `http://localhost:3101/api/integrations/google/callback`.
   Preserve `http://localhost:3000/api/integrations/google/callback` and all other
   existing entries. Save. The dashboard's port 5274 is not the OAuth callback.
5. Fresh consent is not required for the restored authorization now. If a future
   reconnect is required, start it from the isolated YIBO dashboard's Google
   Calendar Connect/Reconnect action, choose the account with calendar access,
   grant the requested permissions and let Google return to the callback.
   Do not open the callback directly; it needs a fresh code and signed state.
6. If the consent screen is in External/Testing, confirm the signing-in account is
   a test user. Such calendar refresh tokens can expire after seven days; this is
   a possible recurrence risk, not a verified explanation of the old token failure.

Focused validation: **13 passed** across `google-oauth-service.test.ts` and
`google-calendar-callback.test.ts`. No full suite run for this fix.

References: [Calendar metadata scopes](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/get),
[event scopes](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[OAuth redirect rules](https://developers.google.com/identity/protocols/oauth2/web-server),
[refresh-token expiration](https://developers.google.com/identity/protocols/oauth2),
[Cloud MFA requirement](https://docs.cloud.google.com/docs/authentication/mfa-requirement).
