# CreditFlow

A private money app with two separate portals behind one account:

- **Personal**: monthly income and plan, entries for bills, fun, other spending, savings, investment and investment returns, a stop screen when an entry crosses a limit, and a spending forecast.
- **Business**: customers, credit given, payments received, credit limits and overdue tracking.

Each user picks Personal, Business or Both, plus a country and currency.

It is a Node.js server with a MySQL database. It has one outside package (`mysql2`, the MySQL driver, pinned to an exact version) and uses no outside services.

## Folder layout

| Path | What it is |
|---|---|
| `public/` | The app's screens (HTML, CSS, JavaScript, font, icons). Only this folder is served to browsers |
| `server/` | The server. `server/index.js` starts it |
| `.env.sample` | Copy to `.env` and fill in your database details |
| `db/schema.sql` | Creates the database tables |
| `deploy/` | Ready-made settings for Caddy (HTTPS) and systemd (keeps the app running) |
| `public/privacy.html` | Privacy policy. **Fill in the bracketed parts before launch** |
| `tests/` | Automated checks |

## Put it online

You need a small Linux server (VPS), for example from Hetzner, DigitalOcean or Contabo, with Ubuntu 24.04 and a domain name pointed at it. The steps below assume Ubuntu.

1. **Install the software**:

   ```bash
   sudo apt update && sudo apt install -y mysql-server caddy
   ```

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
   ```

2. **Create the database** (replace `A_LONG_RANDOM_PASSWORD`; `openssl rand -base64 24` makes one):

   ```bash
   sudo mysql -e "CREATE DATABASE creditflow CHARACTER SET utf8mb4; CREATE USER 'creditflow'@'localhost' IDENTIFIED BY 'A_LONG_RANDOM_PASSWORD'; GRANT SELECT, INSERT, UPDATE, DELETE ON creditflow.* TO 'creditflow'@'localhost';"
   ```

   ```bash
   sudo mysql creditflow < db/schema.sql
   ```

   The app's database user can only read and change rows. It cannot drop tables or change the schema.

3. **Install the app** into `/opt/creditflow` under its own user:

   ```bash
   sudo useradd --system --home /opt/creditflow --shell /usr/sbin/nologin creditflow
   ```

   Copy this `creditflow` folder to `/opt/creditflow`, then:

   ```bash
   cd /opt/creditflow && sudo npm ci --omit=dev
   ```

   ```bash
   sudo cp .env.sample .env && sudo nano .env
   ```

   Enter the database password. Keep `SECURE_COOKIES=true` and `TRUST_PROXY=true`. Then lock the file:

   ```bash
   sudo chown -R root:creditflow /opt/creditflow && sudo chmod 640 /opt/creditflow/.env
   ```

4. **Start it and keep it running**:

   ```bash
   sudo cp deploy/creditflow.service /etc/systemd/system/ && sudo systemctl enable --now creditflow
   ```

5. **Turn on HTTPS**: edit `deploy/Caddyfile`, put your domain in place of `creditflow.example.com`, then:

   ```bash
   sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
   ```

6. **Close everything else**: allow only SSH and web traffic.

   ```bash
   sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
   ```

Open your domain, create your account and add an entry.

`.env` holds your database password. It is in `.gitignore`; never commit it.

## Security and privacy

- **Private by design**: every table has a `user_id` and every query filters on the signed-in user. A user who asks for another user's record gets "not found".
- **Passwords**: stored with scrypt (memory-hard, OWASP settings), never in readable form. Minimum 10 characters.
- **Sessions**: a random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie with the `__Host-` prefix. Only its SHA-256 hash is stored. Changing the password signs out other devices.
- **Sign-in protection**: 5 wrong passwords lock that email for 15 minutes; an IP is limited to 30 failures and 10 sign-ups in 15 minutes, and 300 requests a minute overall.
- **Request forgery**: every change needs a per-session token header, requests from other websites are refused, and sign-in and sign-up need a custom header and a JSON body.
- **SQL injection**: all queries use real server-side prepared statements.
- **Script injection**: every value shown on screen is escaped, and a strict Content Security Policy allows scripts, styles and fonts from this site only.
- **Files**: only `public/` is served. Server code, `.env`, the database schema and hidden files are never sent.
- **Limits**: requests over 64 KB are refused; slow or stalled connections are cut off.
- **No third parties**: no analytics, ads, CDNs or outside AI. The forecast runs on your own server.
- **Locked-down service**: the systemd settings run the app as its own user with no special permissions and a read-only view of the system.
- **User controls**: download all data and delete the account from Settings.
- **Money**: stored as exact decimals and summed in whole minor units, never floating point.

Not included yet:

- **Password reset by email** and **email verification**. These need an email-sending service. Until added, a user who forgets their password cannot get back in.
- **Two-step sign-in** (a code from a phone app).
- **Google sign-in**.
- **Backups and encryption at rest**. Set up daily database backups (for example `mysqldump` to another location) and use your provider's disk encryption.
- Currencies with three decimal places (for example KWD, BHD) are rounded to two.

Keep the server updated (`sudo apt update && sudo apt upgrade`) and check the app's package with `npm audit` from time to time.

## How the forecast and the stop work

- **Stop (red lines)**: checked on the server when an entry is saved. An entry is refused when it would take the month above income, take a spending category above its limit, or leave too little for the savings and investment plan. The user sees a stop screen and can go back or save anyway; with **Hard stop** on (Plan screen) saving anyway is not offered. In Business, the same stop applies to a customer's credit limit.
- **This month's forecast**: day-to-day spending is smoothed with an exponentially weighted average and blended with the pace of earlier months; unpaid bills are assumed at the planned amount. This gives the projected spend, a safe amount per day, and a status of on track, slow down, or heading over.
- **Next month's estimate**: a least-squares trend line through each category's totals for up to six earlier months.

These are small statistical models fitted to the user's own entries. The code is in `server/lib/forecast.js`.

## Run the checks

```bash
npm ci && npm test
```

The end-to-end checks need a throwaway MySQL database loaded with `db/schema.sql`. Put its details in `.env` with `SECURE_COOKIES=false`, then run `npm start` in one terminal and this in another:

```bash
npm run test:api
```

## Publishing on Google Play

The app is an installable web app. Google Play accepts it wrapped as a Trusted Web Activity:

1. Put the app online at its final HTTPS address.
2. Create a Google Play developer account (one-time 25 USD fee, identity verification).
3. Go to pwabuilder.com, enter your site address, choose **Package for stores → Android**, and download the package. It contains the `.aab` file to upload and an `assetlinks.json` file.
4. Put that `assetlinks.json` in `public/.well-known/assetlinks.json`, so Android shows the app full-screen without a browser bar.
5. In Play Console create the app, upload the `.aab`, and fill in:
   - **Privacy policy**: the address of `privacy.html`, with the bracketed parts filled in.
   - **Data safety**: collects name, email and financial info; encrypted in transit; users can request deletion; not shared with third parties.
   - **Account deletion**: users delete their account in Settings → Delete my account. Google also asks for a web address explaining this; the privacy page covers it.
   - **Financial features declaration**: personal budgeting and bookkeeping; no loans, no payments processing.
6. New personal developer accounts must run a closed test with testers before production release. Check Play Console for the current rule.

The font is Figtree, used under the SIL Open Font License (`public/assets/fonts/OFL.txt`).
