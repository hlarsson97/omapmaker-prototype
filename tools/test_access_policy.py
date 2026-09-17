from contextlib import closing
import sqlite3
import tempfile
import unittest
from pathlib import Path

from access_policy import capabilities
from user_store import UserStore


class AccessPolicyTests(unittest.TestCase):
    def test_plans_and_roles_are_independent_and_unknown_values_fail_closed(self):
        self.assertEqual(capabilities('user', 'free'), capabilities('user', 'paid'))
        self.assertNotIn('server:manage', capabilities('user', 'paid'))
        self.assertIn('server:manage', capabilities('admin', 'free'))
        self.assertEqual(capabilities('unknown', 'paid'), [])
        self.assertEqual(capabilities('admin', 'unknown'), [])

    def test_existing_database_migrates_idempotently_without_changing_accounts(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / 'old.sqlite3'
            with closing(sqlite3.connect(database)) as connection:
                connection.execute('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, display_name TEXT, password_hash TEXT, role TEXT, status TEXT, created_at TEXT, updated_at TEXT)')
                connection.execute("INSERT INTO users VALUES ('existing','herman','Herman','unchanged','admin','active','before','before')")
                connection.commit()
            store = UserStore(database)
            UserStore(database)
            user = store.list_users()[0]
            self.assertEqual((user['id'], user['role'], user['plan']), ('existing', 'admin', 'free'))
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(connection.execute('SELECT password_hash FROM users').fetchone()[0], 'unchanged')
            with self.assertRaises(ValueError):store.set_role('missing', 'admin', exclusive=True)
            self.assertEqual(store.list_users()[0]['role'], 'admin')
            with self.assertRaises(ValueError):store.set_plan('herman', 'unknown')
            with self.assertRaises(ValueError):store.set_role('herman', 'user', exclusive=True)


if __name__ == '__main__':
    unittest.main()
