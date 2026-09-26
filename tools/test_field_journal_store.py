"""Journal storage checks independent of the optional map/raster libraries."""
import copy
import tempfile
import unittest
import uuid
from pathlib import Path
from user_store import UserStore


class JournalTests(unittest.TestCase):
    def test_commit_retry_restart_isolation_and_rejected_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'journal.sqlite3'
            store = UserStore(path)
            owner = store.create_user('journal-owner', 'long-enough-test-password')['id']
            other = store.create_user('journal-other', 'long-enough-test-password')['id']
            identifier = str(uuid.uuid4())
            block = {'sequence': 1, 'meta': {'id': identifier, 'sequence': 1, 'pointCount': 1},
                     'points': [{'fix': {'latitude': 59.3, 'longitude': 18.1}}]}
            self.assertFalse(store.append_field_journal(owner, block)['idempotent'])
            store = UserStore(path)  # Reopen after process restart / lost response.
            self.assertTrue(store.append_field_journal(owner, block)['idempotent'])
            self.assertEqual(store.field_journal(owner, identifier, 1), block)
            self.assertEqual(store.field_journal(other), {'sessions': []})
            with self.assertRaises(ValueError): store.field_journal(other, identifier, 1)
            changed = copy.deepcopy(block); changed['points'][0]['fix']['longitude'] = 19
            with self.assertRaises(ValueError): store.append_field_journal(owner, changed)
            gap = copy.deepcopy(block); gap['sequence'] = gap['meta']['sequence'] = 3
            with self.assertRaises(ValueError): store.append_field_journal(owner, gap)
            oversized = copy.deepcopy(block); oversized['points'] *= 129
            with self.assertRaises(ValueError): store.append_field_journal(owner, oversized)
            self.assertEqual(store.field_journal(owner), {'sessions': [block['meta']]})
            self.assertEqual(store.field_journal(owner, identifier, 1), block)


if __name__ == '__main__':
    unittest.main()
