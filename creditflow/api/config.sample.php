<?php
// Copy this file to config.php and fill in your database details.
// config.php is listed in .gitignore and must never be committed.
return [
    'db_host' => '127.0.0.1',
    'db_port' => 3306,
    'db_name' => 'creditflow',
    'db_user' => 'creditflow',
    'db_pass' => 'CHANGE_ME',
    // true on the live site (HTTPS). Set false only for local testing over http://localhost.
    'secure_cookies' => true,
    // How long a sign-in lasts, in days.
    'session_days' => 30,
];
