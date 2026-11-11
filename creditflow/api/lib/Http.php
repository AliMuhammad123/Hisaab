<?php
declare(strict_types=1);

final class HttpError extends Exception
{
    public function __construct(public int $status, string $message, public array $extra = [])
    {
        parent::__construct($message);
    }
}

final class Http
{
    public static function securityHeaders(): void
    {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header('Referrer-Policy: no-referrer');
        header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
        header_remove('X-Powered-By');
    }

    public static function json(mixed $data, int $status = 200): never
    {
        http_response_code($status);
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    /** Request body as an array. Only JSON is accepted, which also blocks plain cross-site form posts. */
    public static function body(): array
    {
        $type = $_SERVER['CONTENT_TYPE'] ?? '';
        if (stripos($type, 'application/json') !== 0) {
            throw new HttpError(415, 'Send the request as JSON.');
        }
        $raw = file_get_contents('php://input', false, null, 0, 65536);
        $data = json_decode($raw === false ? '' : $raw, true);
        if (!is_array($data)) {
            throw new HttpError(400, 'The request could not be read.');
        }
        return $data;
    }

    public static function ip(): string
    {
        return substr((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 45);
    }
}

/** Input checks. Each returns the cleaned value or throws a 422 with a message the user can act on. */
final class V
{
    public static function text(array $in, string $key, int $max, bool $required = false, string $label = ''): string
    {
        $label = $label ?: ucfirst(str_replace('_', ' ', $key));
        $v = $in[$key] ?? '';
        if (!is_string($v) && !is_numeric($v)) {
            throw new HttpError(422, "$label is not valid.");
        }
        $v = trim(preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', (string)$v) ?? '');
        if ($required && $v === '') {
            throw new HttpError(422, "$label is required.");
        }
        if (mb_strlen($v) > $max) {
            throw new HttpError(422, "$label is too long (max $max characters).");
        }
        return $v;
    }

    public static function email(array $in, string $key = 'email', bool $required = true): string
    {
        $v = mb_strtolower(self::text($in, $key, 190, $required, 'Email'));
        if ($v !== '' && !filter_var($v, FILTER_VALIDATE_EMAIL)) {
            throw new HttpError(422, 'Enter a valid email address.');
        }
        return $v;
    }

    public static function date(array $in, string $key, bool $required = true, string $label = 'Date'): ?string
    {
        $v = $in[$key] ?? null;
        if ($v === null || $v === '') {
            if ($required) {
                throw new HttpError(422, "$label is required.");
            }
            return null;
        }
        $d = is_string($v) ? DateTimeImmutable::createFromFormat('!Y-m-d', $v) : false;
        if (!$d || $d->format('Y-m-d') !== $v || $d->format('Y') < 2000 || $d->format('Y') > 2100) {
            throw new HttpError(422, "$label is not a valid date.");
        }
        return $v;
    }

    public static function month(mixed $v): string
    {
        if (!is_string($v) || !preg_match('/^(20\d\d)-(0[1-9]|1[0-2])$/', $v)) {
            throw new HttpError(422, 'Month is not valid.');
        }
        return $v;
    }

    public static function choice(array $in, string $key, array $allowed, string $label = ''): string
    {
        $v = $in[$key] ?? null;
        if (!is_string($v) || !in_array($v, $allowed, true)) {
            $label = $label ?: ucfirst($key);
            throw new HttpError(422, "$label is not valid.");
        }
        return $v;
    }

    public static function id(mixed $v, string $label = 'Item'): int
    {
        if ((is_int($v) || (is_string($v) && ctype_digit($v))) && (int)$v > 0) {
            return (int)$v;
        }
        throw new HttpError(422, "$label is not valid.");
    }
}

/**
 * Money is handled as whole minor units (cents) so sums never pick up
 * floating-point errors. Amounts travel as numbers with two decimals.
 */
final class Money
{
    public const MAX = 99999999999; // 999,999,999.99

    public static function parse(array $in, string $key, string $label, bool $allowZero = false): int
    {
        $v = $in[$key] ?? null;
        if (is_int($v) || is_float($v)) {
            $v = number_format((float)$v, 2, '.', '');
        }
        if (!is_string($v) || !preg_match('/^\d{1,12}(\.\d{1,2})?$/', trim($v))) {
            throw new HttpError(422, "$label must be a number, for example 1500 or 1500.50.");
        }
        $c = self::fromDb(trim($v));
        if ($c > self::MAX) {
            throw new HttpError(422, "$label is too large.");
        }
        if ($c === 0 && !$allowZero) {
            throw new HttpError(422, "$label must be more than zero.");
        }
        return $c;
    }

    public static function fromDb(null|string|int|float $v): int
    {
        if ($v === null) {
            return 0;
        }
        $s = is_string($v) ? $v : number_format((float)$v, 2, '.', '');
        $neg = str_starts_with($s, '-');
        $s = ltrim($s, '-');
        [$whole, $frac] = array_pad(explode('.', $s, 2), 2, '');
        $c = (int)$whole * 100 + (int)str_pad(substr($frac, 0, 2), 2, '0');
        return $neg ? -$c : $c;
    }

    public static function toDb(int $c): string
    {
        return sprintf('%s%d.%02d', $c < 0 ? '-' : '', intdiv(abs($c), 100), abs($c) % 100);
    }

    public static function out(int $c): float
    {
        return round($c / 100, 2);
    }
}
