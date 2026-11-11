<?php
declare(strict_types=1);

// CreditFlow API entry point. Every request to /api/index.php/<route> lands here.

require __DIR__ . '/lib/Http.php';
require __DIR__ . '/lib/Db.php';
require __DIR__ . '/lib/Auth.php';
require __DIR__ . '/lib/Forecast.php';
require __DIR__ . '/lib/Business.php';
require __DIR__ . '/lib/Personal.php';

ini_set('display_errors', '0');
Http::securityHeaders();

try {
    $configFile = __DIR__ . '/config.php';
    if (!is_file($configFile)) {
        throw new HttpError(503, 'The app is not set up yet. Create api/config.php from api/config.sample.php.');
    }
    $cfg = require $configFile;
    Db::connect($cfg);
    Auth::init($cfg);
    Auth::load();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $path = '/' . trim((string)($_SERVER['PATH_INFO'] ?? ''), '/');

    // Anything that changes data needs the CSRF token, except sign-in and
    // sign-up, which have no session yet and are protected by a custom header.
    $open = ['/auth/login', '/auth/register'];
    if ($method !== 'GET' && !in_array($path, $open, true)) {
        Auth::requireCsrf();
    }

    Http::json(route($method, $path));
} catch (HttpError $e) {
    Http::json(['error' => $e->getMessage()] + $e->extra, $e->status);
} catch (Throwable $e) {
    error_log('creditflow: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    Http::json(['error' => 'Something went wrong on our side. Please try again.'], 500);
}

function route(string $method, string $path): array
{
    $today = clientToday();
    $id = null;
    if (preg_match('#^(/[a-z/]+)/(\d+)$#', $path, $m)) {
        [$path, $id] = [$m[1] . '/:id', (int)$m[2]];
    }

    switch ("$method $path") {
        // ----- account -----
        case 'POST /auth/register':
            return ['user' => Auth::register(Http::body())];
        case 'POST /auth/login':
            return ['user' => Auth::login(Http::body())];
        case 'POST /auth/logout':
            Auth::logout();
            return ['ok' => true];
        case 'GET /auth/me':
            return ['user' => Auth::publicUser()];
        case 'PATCH /me':
            return ['user' => updateProfile(Http::body())];
        case 'POST /me/password':
            Auth::changePassword(Http::body());
            return ['ok' => true];
        case 'POST /me/delete':
            Auth::deleteAccount(Http::body());
            return ['ok' => true];
        case 'GET /me/export':
            return exportAll();

        // ----- business -----
        case 'GET /business/summary':
            requirePortal('business');
            return Business::summary($today);
        case 'GET /clients':
            requirePortal('business');
            return ['clients' => Business::clients()];
        case 'POST /clients':
            requirePortal('business');
            return ['client' => Business::saveClient(Http::body())];
        case 'PATCH /clients/:id':
            requirePortal('business');
            return ['client' => Business::saveClient(Http::body(), $id)];
        case 'DELETE /clients/:id':
            requirePortal('business');
            Business::deleteClient($id);
            return ['ok' => true];
        case 'GET /invoices':
            requirePortal('business');
            $cid = isset($_GET['client_id']) ? V::id($_GET['client_id'], 'Client') : null;
            return ['invoices' => Business::invoices($cid)];
        case 'POST /invoices':
            requirePortal('business');
            return ['invoice' => Business::addInvoice(Http::body())];
        case 'DELETE /invoices/:id':
            requirePortal('business');
            Business::deleteInvoice($id);
            return ['ok' => true];
        case 'GET /payments':
            requirePortal('business');
            $iid = isset($_GET['invoice_id']) ? V::id($_GET['invoice_id'], 'Credit entry') : null;
            return ['payments' => Business::payments($iid)];
        case 'POST /payments':
            requirePortal('business');
            return ['invoice' => Business::addPayment(Http::body())];
        case 'DELETE /payments/:id':
            requirePortal('business');
            Business::deletePayment($id);
            return ['ok' => true];

        // ----- personal -----
        case 'GET /personal/summary':
            requirePortal('personal');
            return Personal::summary(V::month($_GET['month'] ?? substr($today, 0, 7)), $today);
        case 'PUT /budget':
            requirePortal('personal');
            return ['budget' => Personal::saveBudget(Http::body())];
        case 'POST /entries':
            requirePortal('personal');
            return Personal::addEntry(Http::body());
        case 'DELETE /entries/:id':
            requirePortal('personal');
            Personal::deleteEntry($id);
            return ['ok' => true];
    }
    throw new HttpError(404, 'Not found.');
}

/** A user who chose only one portal cannot reach the other one's data routes. */
function requirePortal(string $portal): void
{
    $mode = Auth::user()['app_mode'];
    if ($mode !== 'both' && $mode !== $portal) {
        throw new HttpError(403, 'This part of the app is turned off for your account. Turn it on in Settings.');
    }
}

/**
 * "Today" in the user's own time zone, sent by the app. It is only accepted
 * when it is within a day of the server's date, so it cannot be used to
 * move entries far into the past or future.
 */
function clientToday(): string
{
    $server = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    $sent = $_SERVER['HTTP_X_CLIENT_DATE'] ?? '';
    if (is_string($sent) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $sent)) {
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $sent, new DateTimeZone('UTC'));
        if ($d && abs($d->getTimestamp() - $server->setTime(0, 0)->getTimestamp()) <= 86400) {
            return $sent;
        }
    }
    return $server->format('Y-m-d');
}

function updateProfile(array $in): array
{
    $set = [];
    $params = [];
    if (array_key_exists('name', $in)) {
        $set[] = 'name = ?';
        $params[] = V::text($in, 'name', 80, true, 'Your name');
    }
    if (array_key_exists('app_mode', $in)) {
        $set[] = 'app_mode = ?';
        $params[] = V::choice($in, 'app_mode', ['personal', 'business', 'both'], 'Portal choice');
    }
    if (array_key_exists('country', $in)) {
        if (!is_string($in['country']) || !preg_match('/^[A-Z]{2}$/', $in['country'])) {
            throw new HttpError(422, 'Choose a country from the list.');
        }
        $set[] = 'country = ?';
        $params[] = $in['country'];
    }
    if (array_key_exists('currency', $in)) {
        if (!is_string($in['currency']) || !preg_match('/^[A-Z]{3}$/', $in['currency'])) {
            throw new HttpError(422, 'Choose a currency from the list.');
        }
        $set[] = 'currency = ?';
        $params[] = $in['currency'];
    }
    if (array_key_exists('strict_stop', $in)) {
        $set[] = 'strict_stop = ?';
        $params[] = $in['strict_stop'] === true ? 1 : 0;
    }
    if ($set) {
        $params[] = Auth::uid();
        Db::run('UPDATE users SET ' . implode(', ', $set) . ' WHERE id = ?', $params);
        Auth::refreshUser();
    }
    return Auth::publicUser();
}

/** Everything the app holds about the signed-in user, for download. */
function exportAll(): array
{
    $uid = Auth::uid();
    $u = Auth::publicUser();
    unset($u['csrf']);
    return [
        'exported_at' => gmdate('c'),
        'account' => $u,
        'clients' => Db::all('SELECT id, name, phone, email, notes, credit_limit, created_at FROM clients WHERE user_id = ?', [$uid]),
        'credit_entries' => Db::all('SELECT id, client_id, number, description, amount, invoice_date, due_date FROM invoices WHERE user_id = ?', [$uid]),
        'payments' => Db::all('SELECT id, invoice_id, amount, method, payment_date, reference FROM payments WHERE user_id = ?', [$uid]),
        'monthly_plans' => Db::all('SELECT month, income, mandatory, savings, investment, entertainment, other FROM budgets WHERE user_id = ?', [$uid]),
        'personal_entries' => Db::all('SELECT id, category, amount, entry_date, note, overridden FROM entries WHERE user_id = ?', [$uid]),
    ];
}
