"""Team API dispatch; authentication and CSRF are enforced before routing."""
import urllib.parse

from team_store import TeamAccessError, TeamConflict


def handle_team_request(handler, store, method):
    parsed = urllib.parse.urlparse(handler.path)
    parts = parsed.path.strip('/').split('/')
    if len(parts) < 2 or parts[1] not in ('teams', 'team-workspaces'):
        return False
    session = handler.require_session(csrf=method != 'GET')
    if not session:
        return True
    user = session['user']['id']
    query = urllib.parse.parse_qs(parsed.query)
    def read_body(limit):
        body = handler.read_json(limit)
        if not isinstance(body, dict):
            raise ValueError('Begäran måste vara ett JSON-objekt')
        return body
    try:
        if parts == ['api', 'teams']:
            if method == 'GET':
                result = {'teams': store.list_teams(user)}
            elif method == 'POST':
                result = store.create_team(user, read_body(128_000).get('name'))
            else:
                raise ValueError('Okänd åtgärd')
        elif len(parts) == 4 and parts[1] == 'teams' and parts[3] == 'members':
            if method == 'GET':
                result = {'members': store.members(user, parts[2])}
            elif method == 'POST':
                body = read_body(128_000)
                result = store.set_member(user, parts[2], body.get('username'), body.get('role'))
            else:
                raise ValueError('Okänd åtgärd')
        elif parts == ['api', 'team-workspaces']:
            if method == 'GET':
                result = {'workspaces': store.list_workspaces(user)}
            elif method == 'POST':
                body = read_body(128_000)
                result = store.create_workspace(user, body.get('teamId'), body.get('workspace'))
            else:
                raise ValueError('Okänd åtgärd')
        elif len(parts) == 4 and parts[1] == 'team-workspaces':
            if method == 'GET' and parts[3] == 'data':
                result = store.data(user, parts[2], (query.get('since') or [0])[0])
            elif method == 'GET' and parts[3] == 'history':
                result = store.history(user, parts[2], (query.get('before') or [0])[0])
            elif method == 'POST' and parts[3] == 'sync':
                body = read_body(25_000_000)
                result = store.sync(user, parts[2], body.get('mutationId'), body.get('changes'))
            else:
                raise ValueError('Okänd åtgärd')
        else:
            handler.send_json(404, {'error': 'Okänd API-adress'})
            return True
        handler.send_json(200, result)
    except TeamAccessError as exc:
        handler.send_json(403, {'error': str(exc), 'code': 'team_access_denied'})
    except TeamConflict as exc:
        handler.send_json(409, {'error': str(exc), 'code': 'team_conflict', 'current': exc.current})
    except (ValueError, TypeError, OverflowError) as exc:
        handler.send_json(400, {'error': str(exc)})
    return True
