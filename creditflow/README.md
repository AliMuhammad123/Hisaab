# CreditFlow

An Android app where people manage and track their money, with two separate portals behind one account:

- **Personal**: monthly income and plan, entries for bills, fun, other spending, savings, investment and investment returns, a stop screen when an entry crosses a limit, and a spending forecast.
- **Business**: customers, credit given, payments received, credit limits and overdue tracking.

Each user picks Personal, Business or Both, plus a country and currency.

There is no server to run. The app talks directly to **Supabase**, which stores the data and handles sign-in. The Android file is built by **GitHub** on its own machines.

## 1. Set up Supabase (once, about 10 minutes)

1. Create a free account at supabase.com and a **New project**. Choose a strong database password and the region closest to your users.
2. Open **SQL Editor → New query**, paste everything from `supabase/schema.sql`, and press **Run**. It should finish with "Success. No rows returned".
3. Open **Authentication → Sign In / Providers → Email**:
   - **Confirm email**: on.
   - **Minimum password length**: 10.
4. Open **Authentication → Emails** and edit two templates so they contain the code, not only a link:
   - **Confirm signup**, message body:

     ```
     <h2>Your CreditFlow code</h2><p>Enter this code in the app to confirm your email: <strong>{{ .Token }}</strong></p>
     ```

   - **Reset password**, message body:

     ```
     <h2>Reset your CreditFlow password</h2><p>Enter this code in the app: <strong>{{ .Token }}</strong></p><p>If you did not ask for this, ignore this email.</p>
     ```

5. Open **Project Settings → API** (or **API Keys**) and copy two values:
   - **Project URL**, like `https://abcdefghijk.supabase.co`
   - the **anon** or **publishable** key

   Put them into `app.config.json`. These two values are meant to be inside the app: the database rules from step 2 are what keep data private.

   **Never** use the `service_role` or `secret` key. It bypasses every privacy rule. The build refuses to run if it sees one.

**Emails while testing:** Supabase's built-in email service only sends to the email addresses of your Supabase team, a few per hour. That is enough to test with your own email. Before inviting other testers, connect a free email service (for example Brevo or Resend) under **Authentication → Emails → SMTP Settings**.

## 2. Get the test app on your phone

Every change pushed to GitHub builds a new test app automatically.

1. On GitHub, open the repository's **Actions** tab → **CreditFlow Android app** → the latest run with a green tick.
2. Under **Artifacts**, download **CreditFlow-test-app** and unzip it. Inside is `app-debug.apk`.
3. Send the APK to your Android phone and open it. Android asks you to allow installing from that source; allow it for this install.

To build again without a code change: **Actions → CreditFlow Android app → Run workflow**.

## 3. Publish on Google Play (after testing)

1. Create a Google Play developer account (one-time 25 USD fee, identity verification).
2. Create an **upload key** and add it to GitHub as secrets, so GitHub can build the signed Play Store file (`.aab`). This step is not set up yet.
3. In Play Console create the app with the package name `com.alimuhammad.creditflow`. **It can never change after the first upload.** If you want a different one, change `appId` in `capacitor.config.json` before then.
4. Upload the `.aab` and fill in:
   - **Privacy policy**: a public web address of `public/privacy.html`, with the bracketed parts filled in. GitHub Pages can host it for free.
   - **Data safety**: collects name, email and financial info; encrypted in transit; users can delete their account; not shared with third parties; processed by Supabase.
   - **Account deletion**: Settings → Delete my account.
   - **Financial features declaration**: personal budgeting and bookkeeping; no loans, no payments processing.
5. New personal developer accounts must run a closed test with testers before release. Check Play Console for the current rule.

## Security and privacy

- **Private by design**: Row Level Security is on for every table, and each rule only allows the signed-in user's own rows. Composite keys stop anyone attaching their rows to someone else's customer or credit entry. Signed-out visitors can read nothing.
- **Checked in the database**: amounts, dates, text lengths and "a payment cannot exceed what is owed" are enforced by the database, not only by the app.
- **Sign-in**: handled by Supabase. Passwords are stored as one-way hashes, sign-in attempts are rate-limited, and new accounts confirm their email with a code.
- **Account deletion** removes the account and every row it owns.
- **On the phone**: app data is excluded from cloud backups and phone-to-phone transfers, plain-http traffic is blocked, and in the release build the screens cannot be inspected with debugging tools.
- **In the app**: everything shown on screen is escaped, and a Content Security Policy only lets the app load its own files and talk to your Supabase project.
- **No third parties**: no analytics, ads or outside AI. The forecast is calculated on the phone.

Not included yet:

- **Two-step sign-in** (a code from a phone app).
- **Data download** for users.
- **Signed Play Store build** (step 3 above).
- Currencies with three decimal places (for example KWD, BHD) are rounded to two.

## How the forecast and the stop work

- **Stop (red lines)**: when an entry is saved, the app refuses it if it would take the month above income, take a spending category above its limit, or leave too little for the savings and investment plan. The user sees a stop screen and can go back or save anyway; with **Hard stop** on (Plan screen) saving anyway is not offered. In Business, the same stop applies to a customer's credit limit.
- **This month's forecast**: day-to-day spending is smoothed with an exponentially weighted average and blended with the pace of earlier months; unpaid bills are assumed at the planned amount.
- **Next month's estimate**: a least-squares trend line through each category's totals for up to six earlier months.

The code is in `src/lib/forecast.js`.

## For developers

| Path | What it is |
|---|---|
| `src/` | The app's code. `src/data.js` reads and saves through Supabase |
| `public/` | Page, styles, font, icons and privacy policy |
| `supabase/schema.sql` | Tables and privacy rules |
| `supabase/tests/` | Privacy checks for the database rules, run on a plain PostgreSQL |
| `android/` | The Android project (Capacitor) |
| `app.config.json` | Supabase address and public key |
| `tests/` | Unit tests, and a stand-in for Supabase used to try the screens in a browser |

```bash
npm ci && npm test
```

```bash
npm run build
```

`npm run build:test` builds a copy into `www-test/` that uses a fake, in-browser Supabase (sign-up code is always 123456), for trying the screens without a project.

The font is Figtree, used under the SIL Open Font License (`public/assets/fonts/OFL.txt`).
