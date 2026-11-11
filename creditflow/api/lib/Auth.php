<?php
declare(strict_types=1);

final class Auth
{
    private const COOKIE = 'cf_session';
    private const MAX_FAILS_PER_EMAIL = 5;
    private const MAX_FAILS_PER_IP = 30;
    private const WINDOW_MINUTES = 15;
    private const MIN_PASSWORD = 10;

    private static array $cfg = [];
    private static ?array $user = null;
    private static ?array $session = null;

    public static function init(array $cfg): void
    {
        self::$cfg = $cfg;
    }

    // ---------- public endpoints ----------

    public static function register(array $in): array
    {
        self::requireAppHeader();
        $email = V::email($in);
        $name = V::text($in, 'name', 80, true, 'Your name');
        $password = self::password($in, 'password');

        self::throttle('register', self::MAX_FAILS_PER_IP);
        self::recordAttempt('register');

        if (Db::one('SELECT id FROM users WHERE email = ?', [$email])) {
            throw new HttpError(409, 'An account with this email already exists. Try signing in.');
        }
        $id = Db::insert(
            'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)',
            [$email, self::hash($password), $name]
        );
        return self::startSession($id);
    }

    public static function login(array $in): array
    {
        self::requireAppHeader();
        $email = V::email($in);
        $password = is_string($in['password'] ?? null) ? $in['password'] : '';

        self::throttle($email, self::MAX_FAILS_PER_EMAIL);

        $row = Db::one('SELECT id, password_hash FROM users WHERE email = ?', [$email]);
        // Always verify against some hash so the response time does not reveal whether the email exists.
        $hash = $row['password_hash'] ?? '$2y$12$1CFEyMdBUb2nkAiJuKfpo.pMjDUZMsjX1rZfXvxuKmoiUtaHsxWka';
        $ok = password_verify($password, $hash) && $row !== null;
        if (!$ok) {
            self::recordAttempt($email);
            throw new HttpError(401, 'Email or password is incorrect.');
        }
        if (password_needs_rehash($row['password_hash'], self::algo())) {
            Db::run('UPDATE users SET password_hash = ? WHERE id = ?', [self::hash($password), $row['id']]);
        }
        Db::run('DELETE FROM login_attempts WHERE email = ?', [$email]);
        return self::startSession((int)$row['id']);
    }

    public static function logout(): void
    {
        if (self::$session) {
            Db::run('DELETE FROM sessions WHERE id = ?', [self::$session['id']]);
        }
        self::clearCookie();
    }

    public static function changePassword(array $in): void
    {
        $u = self::user();
        $row = Db::one('SELECT password_hash FROM users WHERE id = ?', [$u['id']]);
        if (!password_verify(is_string($in['current'] ?? null) ? $in['current'] : '', $row['password_hash'])) {
            throw new HttpError(403, 'Your current password is incorrect.');
        }
        $new = self::password($in, 'new');
        Db::run('UPDATE users SET password_hash = ? WHERE id = ?', [self::hash($new), $u['id']]);
        // Sign out every other device.
        Db::run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [$u['id'], self::$session['id']]);
    }

    /** Permanently removes the account. Foreign keys cascade to every row the user owns. */
    public static function deleteAccount(array $in): void
    {
        $u = self::user();
        $row = Db::one('SELECT password_hash FROM users WHERE id = ?', [$u['id']]);
        if (!password_verify(is_string($in['password'] ?? null) ? $in['password'] : '', $row['password_hash'])) {
            throw new HttpError(403, 'Password is incorrect. Your account was not deleted.');
        }
        Db::run('DELETE FROM users WHERE id = ?', [$u['id']]);
        Db::run('DELETE FROM login_attempts WHERE email = ?', [$u['email']]);
        self::clearCookie();
    }

    // ---------- session handling ----------

    /** Loads the signed-in user from the session cookie, if there is a valid one. */
    public static function load(): void
    {
        $token = $_COOKIE[self::COOKIE] ?? '';
        if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/', $token)) {
            return;
        }
        $s = Db::one(
            'SELECT s.id, s.user_id, s.csrf_token FROM sessions s WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()',
            [hash('sha256', $token)]
        );
        if (!$s) {
            return;
        }
        $u = Db::one(
            'SELECT id, email, name, app_mode, country, currency, strict_stop FROM users WHERE id = ?',
            [$s['user_id']]
        );
        if ($u) {
            self::$session = $s;
            self::$user = $u;
        }
    }

    /** The signed-in user, or a 401 if nobody is signed in. */
    public static function user(): array
    {
        if (!self::$user) {
            throw new HttpError(401, 'Please sign in.');
        }
        return self::$user;
    }

    public static function uid(): int
    {
        return (int)self::user()['id'];
    }

    /** Every request that changes data must echo the session's CSRF token in a header. */
    public static function requireCsrf(): void
    {
        self::user();
        $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!is_string($sent) || !hash_equals(self::$session['csrf_token'], $sent)) {
            throw new HttpError(403, 'Your session has expired. Reload the page and try again.');
        }
    }

    public static function publicUser(): array
    {
        $u = self::user();
        return [
            'id' => (int)$u['id'],
            'email' => $u['email'],
            'name' => $u['name'],
            'app_mode' => $u['app_mode'],
            'country' => $u['country'],
            'currency' => $u['currency'],
            'strict_stop' => (bool)$u['strict_stop'],
            'csrf' => self::$session['csrf_token'],
        ];
    }

    public static function refreshUser(): void
    {
        self::$user = Db::one(
            'SELECT id, email, name, app_mode, country, currency, strict_stop FROM users WHERE id = ?',
            [self::uid()]
        );
    }

    // ---------- internals ----------

    private static function startSession(int $userId): array
    {
        $token = bin2hex(random_bytes(32));
        $csrf = bin2hex(random_bytes(32));
        $days = max(1, (int)(self::$cfg['session_days'] ?? 30));
        Db::run('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
        $sid = Db::insert(
            'INSERT INTO sessions (user_id, token_hash, csrf_token, user_agent, expires_at)
             VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))',
            [$userId, hash('sha256', $token), $csrf, substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255), $days]
        );
        setcookie(self::COOKIE, $token, [
            'expires' => time() + $days * 86400,
            'path' => '/',
            'secure' => (bool)(self::$cfg['secure_cookies'] ?? true),
            'httponly' => true,       // page scripts cannot read the token
            'samesite' => 'Strict',   // never sent on requests started by other sites
        ]);
        self::$session = ['id' => $sid, 'user_id' => $userId, 'csrf_token' => $csrf];
        self::refreshUserById($userId);
        return self::publicUser();
    }

    private static function refreshUserById(int $id): void
    {
        self::$user = Db::one(
            'SELECT id, email, name, app_mode, country, currency, strict_stop FROM users WHERE id = ?',
            [$id]
        );
    }

    private static function clearCookie(): void
    {
        setcookie(self::COOKIE, '', [
            'expires' => 1,
            'path' => '/',
            'secure' => (bool)(self::$cfg['secure_cookies'] ?? true),
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        self::$user = null;
        self::$session = null;
    }

    /** Sign-in and sign-up have no session yet, so they require a header that other sites cannot add. */
    private static function requireAppHeader(): void
    {
        if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'creditflow') {
            throw new HttpError(403, 'This request was blocked.');
        }
    }

    private static function password(array $in, string $key): string
    {
        $p = $in[$key] ?? '';
        if (!is_string($p) || mb_strlen($p) < self::MIN_PASSWORD) {
            throw new HttpError(422, 'Password must be at least ' . self::MIN_PASSWORD . ' characters.');
        }
        if (strlen($p) > 200) {
            throw new HttpError(422, 'Password is too long.');
        }
        return $p;
    }

    private static function algo(): string|int
    {
        return defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT;
    }

    private static function hash(string $password): string
    {
        return password_hash($password, self::algo());
    }

    private static function throttle(string $key, int $maxForKey): void
    {
        $since = gmdate('Y-m-d H:i:s', time() - self::WINDOW_MINUTES * 60);
        $byKey = (int)Db::one('SELECT COUNT(*) c FROM login_attempts WHERE email = ? AND attempted_at > ?', [$key, $since])['c'];
        $byIp = (int)Db::one('SELECT COUNT(*) c FROM login_attempts WHERE ip = ? AND attempted_at > ?', [Http::ip(), $since])['c'];
        if ($byKey >= $maxForKey || $byIp >= self::MAX_FAILS_PER_IP) {
            throw new HttpError(429, 'Too many attempts. Wait ' . self::WINDOW_MINUTES . ' minutes and try again.');
        }
    }

    private static function recordAttempt(string $key): void
    {
        Db::run('INSERT INTO login_attempts (email, ip) VALUES (?, ?)', [$key, Http::ip()]);
        if (random_int(1, 50) === 1) {
            Db::run('DELETE FROM login_attempts WHERE attempted_at < ?', [gmdate('Y-m-d H:i:s', time() - 86400)]);
        }
    }
}
