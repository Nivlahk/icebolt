# Google setup and sign-in

## Why there is a setup step at all

Every app that opens Google's sign-in popup needs an OAuth **client ID**, registered once by the app's developer. Google offers no API to create one for browser apps, so a few clicks in the Google Cloud console are unavoidable. `icebolt setup google` automates everything around those clicks. Your users never see any of this: they click **Connect Google Drive**, pick their account, and they're done.

```bash
npx icebolt setup google
```

Every question shows a suggested answer; press Enter to accept it.

1. **Where the ID goes:** an `.html` file containing `data-google-client-id="…"`, or `.env.local` (`VITE_GOOGLE_CLIENT_ID`) for Vite apps.
2. **Your sites:** suggested from a `CNAME` file plus localhost (`http://localhost:5173` for Vite); origins Google would refuse are rejected up front.
3. **Project and Drive API:** with [gcloud](https://cloud.google.com/sdk/docs/install) installed, the command creates the project and enables the Drive API itself. Without it, it opens those pages for you.
4. **Privacy policy and terms:** generated next to your app in plain language, matched to how Icebolt works (data stays in the user's Drive, nothing reaches you) and naming the outside services your page loads. Links are added to your page, and the command offers to commit and push them, since Google checks they are live.
5. **Console pages:** it opens Branding, Data access, Audience and Clients in order and walks every field. Each value is copied to your clipboard one at a time, ready to paste.
6. **Domain ownership (optional):** proves your domain through Search Console's HTML-file method, so the consent screen shows your app's name. You paste one filename; the command creates and pushes the file.
7. **Client ID:** paste it; it's checked and written into your app.

Already have an ID?

```bash
npx icebolt setup google --client-id 1234-abc.apps.googleusercontent.com
```

Other options: `--write FILE`, `--project ID`, `--origin URL` (repeatable), `--app-name NAME`, `--no-gcloud`. See `npx icebolt --help`.

### Testing vs published

A new consent screen starts in **Testing**: only the Google accounts you add as test users can sign in. To let anyone in, press **Publish app** on the Audience page. Icebolt only uses `drive.file`, a non-sensitive scope, so there is no security review; Google may still verify your branding (home page, privacy policy and terms on your own domain, which step 4 and 6 prepare).

## How sign-in works

`GoogleDriveAuth` wraps Google Identity Services' browser token flow: no server, no client secret, no refresh token. The access token lives only in the tab's memory.

- **The popup** has to open from a click, or browsers block it. Google's script is preloaded when the app starts, so the popup opens synchronously inside the click.
- **Expiry (about an hour):** browser tokens can't be renewed silently in the background. The token is renewed during the user's own clicks and keypresses in its last 5 minutes, which keeps the popup allowed and usually invisible. If the user was idle and it lapsed, the Storage menu shows **Reconnect**; edits keep accumulating locally and are saved as soon as they reconnect.
- **Permissions:** only `drive.file` is requested. If the user unchecks Drive access on Google's screen, sign-in fails clearly (`scope-denied`) and the token is revoked, instead of failing later with confusing errors.
- **Your own accounts stay separate.** If your app has its own login, keep it; just don't move the Google sign-in to your server. A server-held refresh token would give the developer standing access to users' Drive files, which is exactly what Icebolt avoids.
