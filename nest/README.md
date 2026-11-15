# Kinzhal Nest · Netlify + Firebase

Your games HQ as a private website:
- **Login** with email and password.
- **Team** with Owner, Editor and Viewer roles.
- **Shared workspace**: tasks, plans, costs and game IDs, synced live.
- **Nightly sync** from Firebase Analytics, AdMob, App Store Connect, RevenueCat and Crashlytics.

| Part | Where it runs |
|---|---|
| The app (`public/`) | Netlify static hosting |
| API (`netlify/functions/api.mjs` → `src/`) | Netlify Functions |
| Nightly sync (`netlify/functions/sync-nightly.mjs`) | Netlify Scheduled Function, 06:00–07:45 Riyadh |
| Users, sign-in, 2-step verification | Firebase Authentication |
| Workspace, metrics, encrypted keys | Cloud Firestore |

## Security at a glance
- **Passwords** are handled only by Firebase Authentication. Kinzhal Nest never sees or stores them.
  - Sign-up requires 12+ characters with upper- and lower-case letters, a number and a symbol.
  - It rejects common words, repeats and your email name.
  - It checks the password against known data breaches. Only the first 5 characters of its SHA-1 fingerprint are sent (k-anonymity), never the password itself.
  - Also turn on the same **password policy** in Firebase (step 3) so the rules hold even outside the app.
- **Email verification** is required before anyone gets access.
- **Invite-only**: only `OWNER_EMAIL` and invited emails become members. Anyone else who signs up sees "No access".
- **2-step verification** uses an authenticator app (TOTP). The owner can require it for everyone; the API and the Firestore rules then reject sessions without it.
- **Sign-in throttling**:
  - Firebase blocks repeated failed sign-ins.
  - The app adds its own back-off after 3 failures.
  - Error messages never reveal whether an email exists.
- **Sessions**:
  - Sessions end when the tab closes, unless the user ticks "Keep me signed in".
  - Users are signed out automatically after 30 minutes of inactivity; the owner can change this.
  - "Sign out on all devices" revokes every refresh token, and the API and Firestore rules reject older tokens at once.
  - Signing out clears the local copy of the data on that device.
- **API**: every call needs a verified Firebase ID token, checked with revocation, plus a role check.
  - Request bodies are limited to 64 KB and must be JSON.
  - Key, game ID and team changes are written to an audit log.
- **API keys** (Google, Apple, RevenueCat) are encrypted with AES-256-GCM, using a key derived from `APP_SECRET`, in the Firestore `secrets` collection.
  - The browser can never read them; the security rules deny it.
  - The API returns only masked hints, and only the owner sees those.
- **Google / RevenueCat sign-in** uses OAuth with PKCE and an HMAC-signed, single-use state.
- **Headers** (`netlify.toml`) include:
  - a strict Content-Security-Policy (no inline scripts)
  - HSTS
  - `X-Frame-Options: DENY`
  - `nosniff`
  - a strict referrer policy
  - Permissions-Policy

---

## Setup (about 30 minutes, once)

### 1. Firebase project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**. Using the Firebase project your games already use works too.
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable.** Leave "Email link" off.
3. **Authentication → Settings**:
   - **Password policy**: Require enforcement; minimum length 12; require upper case, lower case, numeric and non-alphanumeric characters.
   - **User account management**: keep **Email enumeration protection** on.
   - **Authorized domains**: add your Netlify domain (e.g. `kinzhal-nest.netlify.app`) and your own domain, if you have one.
4. **Build → Firestore Database → Create database** in production mode. Choose a nearby location such as `europe-west` or `me-central2`.
5. **Firestore → Rules**: paste the content of `firestore.rules` and **Publish**. Alternatively run `npm run rules` with the Firebase CLI.
6. **Project settings → General → Your apps → Web app (</>)**: register an app named "Kinzhal Nest". From the config, copy `apiKey` and `appId`.
7. **Project settings → Service accounts → Generate new private key.** This downloads a JSON file; keep it secret.

#### Optional: 2-step verification (recommended)
TOTP needs the free **Identity Platform** upgrade (Authentication → Settings → upgrade). Then enable TOTP once from a terminal, using an access token for your project:
```
curl -X PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/PROJECT_ID/config?updateMask=mfa" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" \
  -d '{"mfa":{"state":"ENABLED","providerConfigs":[{"state":"ENABLED","totpProviderConfig":{"adjacentIntervals":5}}]}}'
```
After that, each person turns it on in **Account & team → Security → Set up authenticator app**.

### 2. Netlify site
1. Put this folder in a **private GitHub repository**, then in Netlify choose **Add new site → Import an existing project → GitHub**.
   - Don't use drag-and-drop (Netlify Drop): it publishes static files only, without the API and sync functions. The Netlify CLI (`netlify deploy --prod`) also works.
   - Build command: none. Publish directory: `public` (already in `netlify.toml`).
2. **Site configuration → Environment variables**: add these (all values are secrets; tick "Contains secret values"):

| Variable | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | `project_id` from the service-account JSON |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from the JSON |
| `FIREBASE_PRIVATE_KEY` | `private_key` from the JSON (paste as is, with the `\n` characters) |
| `FIREBASE_WEB_API_KEY` | `apiKey` from step 1.6 |
| `FIREBASE_APP_ID` | `appId` from step 1.6 |
| `APP_SECRET` | 48+ random characters, e.g. from `openssl rand -base64 48`. **Never change it later**: saved API keys are encrypted with it. |
| `OWNER_EMAIL` | your email; this account becomes the owner |
| `SITE_URL` | optional: your final address (e.g. `https://nest.example.com`) if you use a custom domain |

3. **Deploys → Trigger deploy.** Netlify installs `firebase-admin` and `jose` from `package.json` for the functions.

### 3. First sign-in
1. Open your site and choose **Invited? Create your account**, using `OWNER_EMAIL`.
2. Open the confirmation email, then press **I've confirmed it**. You are now the owner.
3. **Account & team** (top bar):
   - turn on 2-step verification
   - invite your team (Editor or Viewer)
   - optionally require 2-step for everyone

### Monitoring many games: one service account (recommended)
Kinzhal Nest uses the service account already in Netlify (`FIREBASE_CLIENT_EMAIL`) to read every game project: Firebase/Google Analytics, Firebase apps and Crashlytics in BigQuery. There is no JSON file per game.
1. Reports → Data → Google card → **Service account**: copy the script and run it once in Google Cloud Shell.
   - It enables the needed APIs in your Kinzhal Nest project.
   - It grants `roles/firebase.viewer`, `roles/bigquery.dataViewer` and `roles/bigquery.jobUser` on every game project. Edit `EXCLUDE` to skip non-game projects.
2. Google Analytics → Admin → **Account access management**: add the service account email as **Viewer**. Do this once per Analytics account.
3. Press **Use service account**, then **Test**. Then press **Discover my games**.

AdMob's API does not accept service accounts, so for ad revenue also do **Sign in with Google** once. Both can be on together.

### 4. Connections (Reports → Data)
The full click-by-click guide, with fixes for common errors, is in the app under **Academy → API integrations**.

Three cards, then **Discover my games**:
1. **Google** (Firebase Analytics, AdMob, Crashlytics):
   - Follow the 4 steps shown in the card. Enable APIs, publish the consent screen, create an OAuth web client and add the redirect URI the card shows (`https://YOUR-SITE/api/oauth/google/callback`).
   - Paste the Client ID and secret, then press **Sign in with Google**.
2. **App Store Connect**:
   - Choose the `.p8` key file; the Key ID is read from its file name.
   - Add the Issuer ID and Vendor number, then **Save and test**.
3. **RevenueCat**: paste a secret API key (V2), then **Save and test**.
4. **Discover my games**:
   - Finds every app in those accounts and matches it to your games by bundle ID.
   - Tick what is right and **Apply selected**.
5. **Sync now**: choose "Last 90 days" the first time. After that it runs every night by itself.

### 5. Marketing growth engine (optional)
Marketing → **Spend → Ad accounts** connects the ad networks and the AI analyst. Every key is encrypted like the others.

| Card | What you paste | What it brings |
|---|---|---|
| Apple Search Ads | Client ID, Team ID, Key ID, Org ID, private key (`.pem`) | daily spend, taps, installs per campaign (matched by App Store ID) |
| Snapchat | OAuth Client ID + secret, then **Connect Snapchat** | daily spend, swipes, installs |
| TikTok | access token + advertiser ID | daily spend, clicks, installs |
| Meta | system-user token (`ads_read`) + ad account ID | daily spend, clicks, app installs |
| Google Ads | developer token + customer ID, then Sign in with Google again | daily cost, clicks, conversions |
| AI analyst | Claude API key (console.anthropic.com) | answers from live numbers + a weekly brief every Sunday 07:00 Riyadh |

- Campaigns are matched to games by App Store ID (Apple Search Ads) or by the game name inside the campaign name; fix the rest once in the same page.
- Networks without an API: import a daily CSV per campaign (Date, Campaign, Spend, Impressions, Clicks, Installs).
- App Store Connect also feeds the **store funnel** (impressions → page views → downloads, by country) and **reviews**. Apple starts the funnel reports 1–2 days after the first sync; the API key needs the Admin, Finance or Sales role.
- Spend rolls into each game's daily `ua` (spend) and `paid` (installs), so Finance, KPIs and reports use it too.
- Budget autopilot only **proposes** changes; nothing in your ad accounts is changed automatically.
- New shared workspace key `mk`: publish the updated `firestore.rules`.

### 6. Products and Steam
- **Products**: product board with stage gates and health, roadmap (Now / Next / Later), RICE / ICE prioritization, discovery inbox, one-page specs, experiments with sample sizes, metrics tree, calculators, and PM courses, tips, strategies, stories and glossary. Shared with the team through the `pm` workspace area.
- **Steam**: add each game's **Steam App ID** in Reports → Data → Game IDs. Players-now and review counts sync with no key. For daily sales (units, gross, net, refunds) add a **Financial Web API key** (Steamworks → Users & Permissions → Manage Groups → Financial API group) in Steam → Connect; leave its IP allow-list empty because Netlify has no fixed IPs. Launch plan, store page checklist, wishlist CSV import, discount planner with Valve's rules, the official sales calendar, Steamworks/Steam Deck guide, calculators and courses are in the same section.
- `firestore.rules` now accepts any short workspace area name, so new sections need no rules update.

---

## Data model (Firestore)
| Path | Who can read | Content |
|---|---|---|
| `members/{uid}` | that user (rules); API | role, `revokedAt`, `mfa` flag |
| `ws/{key}` | members (rules); editors and the owner write | shared workspace, one document per area (`tasks`, `games`, `cc`, …) as JSON text |
| `invites/{email}`, `team/settings`, `audit/*` | API only | team management |
| `secrets/keys` | API only | encrypted API keys |
| `metricsByGame/{gameId}` | API only | daily metrics (about 420 days kept) |
| `kv/*` | API only | game IDs, funnels, mediation, sync status and queue, ad spend (`ads:{network}`), campaign names and mapping, reviews, store funnel by country, weekly brief |

## API (all calls need `Authorization: Bearer <Firebase ID token>`)
| Method & path | Role | Purpose |
|---|---|---|
| `GET /api/config` | public | Firebase web config for the sign-in page |
| `GET /api/me` | member | who am I (creates the owner / accepts an invite) |
| `POST /api/auth/revoke` | member | sign out on every device |
| `GET /api/live?days=150`, `GET /api/daily.csv` | viewer | metrics |
| `GET /api/integrations` | viewer | status of every connection + game IDs |
| `POST /api/integrations/{google,apple,revenuecat,ratings}` | owner | save keys `{values:{…}}`, then auto-test |
| `POST /api/integrations/:service/test` | editor | run that service's tests |
| `DELETE /api/integrations/:service` | owner | disconnect |
| `POST /api/oauth/{google,revenuecat}/start` | owner | sign-in URL |
| `POST /api/discover` | editor | find apps and propose game IDs |
| `PUT /api/games` | editor | save game IDs |
| `POST /api/sync` / `GET /api/sync` | editor / viewer | run (in steps) / check a sync |
| `GET /api/marketing` | viewer | ad spend rows, campaign mapping, reviews, store funnel by country, weekly brief |
| `PUT /api/ads/map` · `POST /api/ads/import` | editor | assign campaigns to games · import a CSV report |
| `POST /api/ai` · `POST /api/brief` | editor | ask the AI analyst · write the brief now |
| `GET /api/team`, `POST /api/team/invites`, `DELETE /api/team/invites/:email`, `PATCH`/`DELETE /api/team/members/:uid`, `PUT /api/team/settings` | owner | team |

## Development
```
npm install
npm test          # offline: parsers + the whole API with an in-memory database and fake Firebase Auth
npm run build     # app/kinzhal-nest.html -> public/index.html + public/app.js
```
`app/kinzhal-nest.html` is the same single file as the Claude artifact. When the artifact changes, replace the file and run `npm run build`.

## Limits worth knowing
- Netlify functions have short time limits, so a sync runs as small jobs. "Sync now" keeps calling until the queue is empty, and the nightly run continues every 15 minutes until done.
- RevenueCat reports one revenue total per project. Use one project per game for per-game revenue.
- Apple publishes each day's sales report the next day, so the newest day may fill in on the following sync.
- The AI analyst on the website needs your own Claude API key; answers must finish within Netlify's ~10 s function limit, so long questions may need the faster `claude-haiku-5-5` model. The Sunday brief runs as a scheduled function with more time.
