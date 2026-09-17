"""Isolated browser-test fixture without GIS dependencies or production data."""
import json
import tempfile
import urllib.parse
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from team_api import handle_team_request
from team_store import TeamStore
from user_store import UserStore


def main():
    with tempfile.TemporaryDirectory() as temporary:
        users = UserStore(Path(temporary) / 'browser.sqlite3')
        for username in ('owner', 'editor', 'viewer'):
            users.create_user(username, 'browser-test-password')
        teams = TeamStore(users.path)
        root = str(Path(__file__).resolve().parents[1])

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=root, **kwargs)

            def send_json(self, status, value, cookie=None):
                encoded = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                if cookie: self.send_header('Set-Cookie', cookie)
                self.end_headers()
                self.wfile.write(encoded)

            def read_json(self, limit=25_000_000):
                length = int(self.headers.get('Content-Length', 0))
                if length > limit: raise ValueError('För stort anrop')
                return json.loads(self.rfile.read(length))

            def session(self):
                cookie = SimpleCookie(self.headers.get('Cookie', ''))
                return users.session(cookie['session'].value) if 'session' in cookie else None

            def require_session(self, csrf=False):
                session = self.session()
                if not session:
                    self.send_json(401, {'error': 'Logga in'})
                    return None
                if csrf and self.headers.get('X-OMapMaker-CSRF') != session['csrfToken']:
                    self.send_json(403, {'error': 'CSRF'})
                    return None
                return session

            def do_GET(self):
                if handle_team_request(self, teams, 'GET'): return
                path = urllib.parse.urlparse(self.path).path
                if path == '/api/auth/session':
                    session = self.session()
                    return self.send_json(200, {'authenticated': bool(session), **({key: session[key] for key in ('user', 'csrfToken')} if session else {})})
                if path.startswith('/api/'):
                    session = self.require_session()
                    if not session: return
                    user = session['user']['id']
                    if path == '/api/workspaces': return self.send_json(200, {'workspaces': users.list_workspaces(user)})
                    if path == '/api/user-data': return self.send_json(200, users.user_data(user))
                    if path == '/api/map-layers': return self.send_json(200, {'layers': []})
                    return self.send_json(200, {'type': 'FeatureCollection', 'features': [], 'layers': [], 'connected': False})
                return super().do_GET()

            def do_POST(self):
                if self.path == '/api/auth/login':
                    body = self.read_json()
                    session = users.login(body['username'], body['password'])
                    return self.send_json(200, {'authenticated': True, 'user': session['user'], 'csrfToken': session['csrfToken']}, f"session={session['token']}; HttpOnly; SameSite=Strict; Path=/")
                if handle_team_request(self, teams, 'POST'): return
                session = self.require_session(csrf=True)
                if not session: return
                body = self.read_json()
                if self.path == '/api/user-data/sync':
                    return self.send_json(200, users.sync_user_data(session['user']['id'], body['mutationId'], body.get('objects', []), body.get('fieldSurveys', []), body.get('layerOverrides', [])))
                return self.send_json(200, {'layers': [], 'layer': None})

        server = ThreadingHTTPServer(('127.0.0.1', 8876), Handler)
        print('Team browser fixture ready at http://127.0.0.1:8876', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
