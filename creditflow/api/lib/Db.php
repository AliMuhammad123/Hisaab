<?php
declare(strict_types=1);

final class Db
{
    private static ?PDO $pdo = null;

    public static function connect(array $cfg): void
    {
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $cfg['db_host'], (int)$cfg['db_port'], $cfg['db_name']);
        self::$pdo = new PDO($dsn, $cfg['db_user'], $cfg['db_pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            // Real prepared statements: values are never spliced into SQL text.
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => true,
        ]);
        self::$pdo->exec("SET time_zone = '+00:00'");
    }

    public static function pdo(): PDO
    {
        return self::$pdo;
    }

    public static function run(string $sql, array $params = []): PDOStatement
    {
        $st = self::$pdo->prepare($sql);
        $st->execute($params);
        return $st;
    }

    public static function all(string $sql, array $params = []): array
    {
        return self::run($sql, $params)->fetchAll();
    }

    public static function one(string $sql, array $params = []): ?array
    {
        $row = self::run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    public static function insert(string $sql, array $params = []): int
    {
        self::run($sql, $params);
        return (int)self::$pdo->lastInsertId();
    }

    /** Runs $fn inside a transaction and rolls back if it throws. */
    public static function tx(callable $fn): mixed
    {
        self::$pdo->beginTransaction();
        try {
            $out = $fn();
            self::$pdo->commit();
            return $out;
        } catch (Throwable $e) {
            if (self::$pdo->inTransaction()) {
                self::$pdo->rollBack();
            }
            throw $e;
        }
    }
}
