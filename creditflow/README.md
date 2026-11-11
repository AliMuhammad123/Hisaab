# CreditFlow

A private money app with two separate portals behind one account:

- **Personal**: monthly income and plan, entries for bills, fun, other spending, savings, investment and investment returns, a stop screen when an entry crosses a limit, and a spending forecast.
- **Business**: customers, credit given, payments received, credit limits and overdue tracking.

Each user picks Personal, Business or Both, plus a country and currency.

It is a plain PHP + MySQL app with no build step and no outside services.

## Folder layout

| Path | What it is |
|---|---|
| `index.html`, `assets/` | The app's screens (HTML, CSS, JavaScript, font, icons) |
| `api/` | The server. `api/index.php` is the only entry point |
| `api/config.sample.php` | Copy to `api/config.php` and fill in your database details |
| `db/schema.sql` | Creates the database tables |
| `privacy.html` | Privacy policy. **Fill in the bracketed parts before launch** |
| `manifest.webmanifest`, `sw.js` | Make the app installable on phones |
| `tests/` | Automated checks |

## Put it online

You need hosting with **PHP 8.1 or newer**, **MySQL 8 or MariaDB 10.4 or newer**, and **HTTPS**.

1. In your hosting panel, create a MySQL database and a database user with a strong password.
2. Import `db/schema.sql` into that database (phpMyAdmin: Import tab).
3. Upload everything inside this `creditflow` folder to your site's web folder (often `public_html`). Include the hidden `.htaccess` file.
4. On the server, copy `api/config.sample.php` to `api/config.php` and enter the database name, user and password. Keep `secure_cookies` as `true`.
5. Open your site. Create your account and check that you can add an entry.

`api/config.php` holds your database password. It is in `.gitignore`; never commit it.

## Security and privacy

- **Private by design**: every table has a `user_id` and every query filters on the signed-in user. A user who asks for another user's record gets "not found".
- **Passwords**: stored with Argon2id (bcrypt if the server lacks it). Minimum 10 characters.
- **Sessions**: a random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Only its SHA-256 hash is stored. Changing the password signs out other devices.
- **Sign-in protection**: 5 wrong passwords lock that email for 15 minutes; an IP is limited to 30 failures in 15 minutes.
- **Request forgery**: every change needs a per-session token header; sign-in and sign-up need a custom header and a JSON body.
- **SQL injection**: all queries use real prepared statements.
- **Script injection**: every value shown on screen is escaped, and a strict Content Security Policy allows scripts, styles and fonts from this site only.
- **No third parties**: no analytics, ads, CDNs or outside AI. The forecast runs on your own server.
- **User controls**: download all data and delete the account from Settings.
- **Money**: stored as exact decimals and summed in whole minor units, never floating point.

Not included yet:

- **Password reset by email** and **email verification**. These need an email-sending service. Until added, a user who forgets their password cannot get back in.
- **Google sign-in**.
- **Database encryption at rest and backups**. Turn these on with your hosting provider.
- Currencies with three decimal places (for example KWD, BHD) are rounded to two.

## How the forecast and the stop work

- **Stop (red lines)**: checked on the server when an entry is saved. An entry is refused when it would take the month above income, take a spending category above its limit, or leave too little for the savings and investment plan. The user sees a stop screen and can go back or save anyway; with **Hard stop** on (Plan screen) saving anyway is not offered. In Business, the same stop applies to a customer's credit limit.
- **This month's forecast**: day-to-day spending is smoothed with an exponentially weighted average and blended with the pace of earlier months; unpaid bills are assumed at the planned amount. This gives the projected spend, a safe amount per day, and a status of on track, slow down, or heading over.
- **Next month's estimate**: a least-squares trend line through each category's totals for up to six earlier months.

These are small statistical models fitted to the user's own entries. The code is in `api/lib/Forecast.php`.

## Run the checks

```bash
php tests/forecast.test.php
```

With a throwaway database configured in `api/config.php` (and `secure_cookies` set to `false` for plain http):

```bash
php -S 127.0.0.1:8080 -t .
```

```bash
node tests/api.test.mjs
```

## Publishing on Google Play

The app is an installable web app. Google Play accepts it wrapped as a Trusted Web Activity:

1. Put the app online at its final HTTPS address (your own domain is best).
2. Create a Google Play developer account (one-time 25 USD fee, identity verification).
3. Go to pwabuilder.com, enter your site address, choose **Package for stores → Android**, and download the package. It contains the `.aab` file to upload and an `assetlinks.json` file.
4. Upload that `assetlinks.json` to `.well-known/assetlinks.json` on your site, so Android shows the app full-screen without a browser bar.
5. In Play Console create the app, upload the `.aab`, and fill in:
   - **Privacy policy**: the address of `privacy.html`, with the bracketed parts filled in.
   - **Data safety**: collects name, email and financial info; encrypted in transit; users can request deletion; not shared with third parties.
   - **Account deletion**: users delete their account in Settings → Delete my account. Google also asks for a web address explaining this; the privacy page covers it.
   - **Financial features declaration**: personal budgeting and bookkeeping; no loans, no payments processing.
6. New personal developer accounts must run a closed test with at least 12 testers for 14 days before production release.

The font is Figtree, used under the SIL Open Font License (`assets/fonts/OFL.txt`).
