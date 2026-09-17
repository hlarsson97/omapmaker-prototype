import concurrent.futures
import json
import tempfile
import unittest
import uuid
from pathlib import Path

from user_store import UserStore
from team_store import TeamAccessError, TeamConflict, TeamStore


def uid():
    return str(uuid.uuid4())


class TeamStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'test.sqlite3'
        self.users = UserStore(self.path)
        self.owner = self.users.create_user('owner', 'test-password-long')['id']
        self.editor = self.users.create_user('editor', 'test-password-long')['id']
        self.viewer = self.users.create_user('viewer', 'test-password-long')['id']
        self.outsider = self.users.create_user('outsider', 'test-password-long')['id']
        self.store = TeamStore(self.path)
        self.team = self.store.create_team(self.owner, 'Skogslaget')['id']
        self.store.set_member(self.owner, self.team, 'editor', 'editor')
        self.store.set_member(self.owner, self.team, 'viewer', 'viewer')
        self.workspace = self.store.create_workspace(self.owner, self.team, {'id': uid(), 'name': 'Skogen', 'center': {'lat': 59, 'lng': 18}, 'sizeKm': 2, 'scale': 10000, 'contourInterval': 5})['id']

    def obj(self, identifier=None, revision=0, **extra):
        identifier = identifier or uid()
        return {'kind': 'object', 'id': identifier, 'category': 'point', 'payload': {'id': identifier, 'coordinates': [18, 59], 'objectType': 'boulder'}, 'expectedRevision': revision, 'deleted': False, **extra}

    def put(self, value, user=None, mutation=None):
        return self.store.sync(user or self.owner, self.workspace, mutation or uid(), [value])['entities'][0]

    def test_member_permissions_and_private_isolation(self):
        self.put(self.obj())
        for user in [self.editor, self.viewer]:
            self.assertEqual(len(self.store.data(user, self.workspace)['entities']), 2)
        for operation in [lambda: self.put(self.obj(), self.viewer), lambda: self.store.data(self.outsider, self.workspace), lambda: self.store.history(self.outsider, self.workspace), lambda: self.store.set_member(self.editor, self.team, 'outsider', 'editor')]:
            with self.assertRaises(TeamAccessError): operation()
        self.assertEqual(self.users.user_data(self.owner)['objects'], [])
        self.assertEqual(self.store.list_workspaces(self.outsider), [])
        with self.assertRaises(ValueError): self.store.set_member(self.owner, self.team, 'owner', 'remove')

    def test_concurrent_same_object_has_one_winner(self):
        first = self.put(self.obj())
        def update(user):
            try:
                self.put(self.obj(first['id'], 1), user)
                return 'saved'
            except TeamConflict:
                return 'conflict'
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            result = list(pool.map(update, [self.owner, self.editor]))
        self.assertCountEqual(result, ['saved', 'conflict'])
        self.assertEqual(len(self.store.history(self.owner, self.workspace)['changes']), 3)

    def test_lost_response_retry_and_membership_revocation(self):
        value, mutation = self.obj(), uid()
        first = self.put(value, self.editor, mutation)
        self.assertEqual(self.put(value, self.editor, mutation), first)
        with self.assertRaises(ValueError): self.put(self.obj(), self.editor, mutation)
        self.store.set_member(self.owner, self.team, 'editor', 'remove')
        with self.assertRaises(TeamAccessError): self.put(value, self.editor, mutation)
        with self.assertRaises(TeamAccessError): self.store.data(self.editor, self.workspace)

    def test_independent_changes_delete_conflict_and_restore(self):
        initial_cursor = self.store.data(self.owner, self.workspace)['cursor']
        first, second = self.put(self.obj()), self.put(self.obj(), self.editor)
        deleted = self.put(self.obj(first['id'], 1, deleted=True))
        with self.assertRaises(TeamConflict): self.put(self.obj(first['id'], 1), self.editor)
        restored = self.put(self.obj(first['id'], deleted['revision']))
        self.assertEqual(restored['revision'], 3)
        delta = self.store.data(self.owner, self.workspace, initial_cursor)
        self.assertEqual({item['id'] for item in delta['entities']}, {first['id'], second['id']})
        self.assertEqual(len(self.store.data(self.owner, self.workspace, delta['cursor'])['entities']), 0)
        history = self.store.history(self.owner, self.workspace)['changes']
        self.assertTrue(any(item['entity']['deleted'] for item in history))
        self.assertEqual(history[0]['author'], 'owner')

    def test_related_batch_is_atomic(self):
        first = self.put(self.obj())
        new = self.obj()
        with self.assertRaises(TeamConflict): self.store.sync(self.editor, self.workspace, uid(), [new, self.obj(first['id'], 0)])
        self.assertNotIn(new['id'], [item['id'] for item in self.store.data(self.owner, self.workspace)['entities']])

    def test_override_history_and_settings(self):
        value = {'kind': 'override', 'id': json.dumps(['roads', 'way/42'], separators=(',', ':')), 'layerType': 'roads', 'featureId': 'way/42', 'payload': {'geometry': {'type': 'LineString', 'coordinates': [[18,59],[18.1,59.1]]}, 'properties': {'status': 'locally-edited'}}, 'expectedRevision': 0}
        self.put(value)
        with self.assertRaises(TeamConflict): self.put(value, self.editor)
        workspace = next(item for item in self.store.data(self.owner, self.workspace)['entities'] if item['kind'] == 'workspace')
        self.put({**workspace, 'expectedRevision': 1, 'payload': {**workspace['payload'], 'name': 'Ny skog'}})
        self.assertEqual(self.store.list_workspaces(self.editor)[0]['name'], 'Ny skog')
        TeamStore(self.path)  # Repeated migration preserves everything.
        self.assertEqual(len(self.store.history(self.owner, self.workspace)['changes']), 3)


if __name__ == '__main__':
    unittest.main()
