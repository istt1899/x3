"""Provider-worker boundaries: private refresh, actual CA wiring and resolved media."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('media_worker', HERE / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_search_keeps_refreshed_private_state_outside_result(self):
        calls = []
        updated = {'tokens': {'access_token': 'fixture-new-private'}}

        class Provider:
            def __init__(self, **kwargs):
                pass

            def auth_status(self, private):
                return {'public': {'state': 'signed_in'}, 'private': updated}

            def search(self, query, auth=None):
                calls.append(auth)
                return {'items': [{'id': 'a' * 32, 'title': 'Video'}]}

        module = types.SimpleNamespace(Provider=Provider, DirectTransport=lambda **kwargs: None)
        with mock.patch.object(worker.importlib, 'import_module', return_value=module), \
             mock.patch.object(worker.ytfetch, 'install_dns'):
            result = worker.perform({'provider': 'rutube', 'op': 'search', 'args': {'q': 'video'},
                                     'private': {'tokens': {'access_token': 'old-private'}}})
        self.assertEqual(calls, [updated])
        self.assertEqual(result['private'], updated)
        self.assertNotIn('fixture-new-private', json.dumps(result['result']))

    def test_failed_personal_request_retains_private_refresh_error(self):
        private = {'tokens': {'refresh_token': 'fixture-recoverable'}}

        class AuthRequired(Exception):
            code = 'auth_required'
            message = 'Sign in again'

        class Provider:
            def __init__(self, **kwargs):
                pass

            def auth_status(self, auth):
                return {'public': {'state': 'signed_in'}, 'private': private}

            def feed(self, which, auth=None):
                raise AuthRequired()

            def auth_refresh(self, auth):
                return {'public': {'state': 'error', 'msg': 'RUTUBE is unavailable'}, 'private': private}

        module = types.SimpleNamespace(Provider=Provider, DirectTransport=lambda **kwargs: None)
        with mock.patch.object(worker.importlib, 'import_module', return_value=module), \
             mock.patch.object(worker.ytfetch, 'install_dns'):
            result = worker.perform({'provider': 'rutube', 'op': 'feed', 'args': {'which': 'subs'}, 'private': private})
        self.assertEqual(result['error']['code'], 'auth_required')
        self.assertEqual(result['private'], private)
        self.assertNotIn('result', result)

    def test_checked_ca_is_installed_before_shipped_ytdlp_import(self):
        with tempfile.TemporaryDirectory() as root:
            ca = Path(root) / 'trusted-fixture.pem'
            ca.write_text('fixture: loading is mocked, TLS is not disabled')

            class Provider:
                def __init__(self, **kwargs):
                    pass

                def auth_poll(self, private):
                    return {'public': {'state': 'signed_out'}, 'private': {}}

            def load(*args):
                self.assertEqual(worker.ytfetch.CA, str(ca))
                return object()

            with mock.patch.object(worker.ytfetch, 'CA', worker.ytfetch.CA), \
                 mock.patch.object(worker.ytfetch, 'load_ytdlp', side_effect=load), \
                 mock.patch.object(worker.ytfetch, 'install_dns'), \
                 mock.patch.object(worker.importlib, 'import_module', return_value=types.SimpleNamespace(Provider=Provider)):
                result = worker.perform({'provider': 'vk', 'op': 'auth_status', 'config': {'ca_bundle': str(ca)}})
            self.assertEqual(result['public']['state'], 'signed_out')

    def test_account_refresh_or_loss_is_reported_even_when_content_fails(self):
        for state, updated in (
            ({'state': 'signed_in'}, {'account': {'access_token': 'fixture-new-private'}}),
            ({'state': 'error', 'msg': 'Sign in again'}, {}),
        ):
            with self.subTest(state=state['state']):
                received = []

                class Provider:
                    def __init__(self, **kwargs):
                        pass

                    def auth_poll(self, auth):
                        return {'public': state, 'private': updated}

                    def search(self, query, auth=None):
                        received.append(auth)
                        raise ValueError('private extractor error must not reach UI')

                with mock.patch.object(worker.ytfetch, 'load_ytdlp', return_value=object()), \
                     mock.patch.object(worker.ytfetch, 'install_dns'), \
                     mock.patch.object(worker.importlib, 'import_module', return_value=types.SimpleNamespace(Provider=Provider)):
                    result = worker.perform({'provider': 'vk', 'op': 'search', 'args': {'q': 'video'},
                                             'private': {'account': {'access_token': 'old-private'}}})
                self.assertIn('error', result)
                self.assertEqual(received, [updated])
                self.assertEqual(result['private'], updated)
                self.assertEqual(result['auth'], state)
                self.assertNotIn('fixture-new-private', json.dumps(result['auth']))
                self.assertNotIn('private extractor error', json.dumps(result['error']))

    def test_vk_job_keeps_alternate_qualities_private(self):
        formats = [{'url': 'https://video.okcdn.ru/' + str(height) + '.mp4', 'height': height,
                    'ext': 'mp4', 'vcodec': 'avc1', 'acodec': 'mp4a'} for height in (360, 720, 1080, 2160)]
        job = worker.playback_job('vk', {'id': '-123_456', 'title': 'Fixture', 'formats': formats}, 720, '/trusted.pem')
        self.assertEqual(job['format']['height'], 720)
        self.assertEqual([entry['height'] for entry in job['formats']], [360, 720, 1080])

    def test_vk_api_revocation_replaces_preflight_signed_in_with_auth_error(self):
        class Revoked(Exception):
            code = 'auth_required'
            message = 'Sign in again'
            auth = {'state': 'error', 'code': 'authorization_expired', 'msg': 'Sign in again'}

        class Provider:
            def __init__(self, **kwargs):
                pass

            def auth_poll(self, private):
                return {'public': {'state': 'signed_in'}, 'private': private}

            def search(self, query, auth=None):
                auth.clear()
                raise Revoked()

        with mock.patch.object(worker.ytfetch, 'load_ytdlp', return_value=object()), \
             mock.patch.object(worker.ytfetch, 'install_dns'), \
             mock.patch.object(worker.importlib, 'import_module', return_value=types.SimpleNamespace(Provider=Provider)):
            result = worker.perform({'provider': 'vk', 'op': 'search', 'args': {'q': 'video'},
                                     'private': {'account': {'access_token': 'fixture-private', 'video_access': True}}})
        self.assertEqual(result['error']['code'], 'auth_required')
        self.assertEqual(result['auth']['state'], 'error')
        self.assertEqual(result['private'], {})

    def test_thumbnail_does_not_accept_arbitrary_or_internal_addresses(self):
        for url in ('https://127.0.0.1/image', 'https://localhost/image', 'https://evil.example/image',
                    'https://pic.rutubelist.ru:444/image', 'http://pic.rutubelist.ru/image'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                worker.thumbnail_https('rutube', url)
        self.assertEqual(worker.thumbnail_https('rutube', 'https://pic.rtbcdn.ru/image'), 'https://pic.rtbcdn.ru/image')

    def test_malformed_worker_stdin_still_returns_safe_json(self):
        result = subprocess.run([sys.executable, str(HERE / 'worker.py')],
                                input=b'{invalid private-fixture-secret', capture_output=True, timeout=10)
        output = json.loads(result.stdout)
        self.assertIn('error', output)
        self.assertNotIn('private-fixture-secret', result.stdout.decode())
        self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()
