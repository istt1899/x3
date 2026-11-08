"""The actual Python CLI parsers must accept the daemon's mixed options on 3.12."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import mediafetch


class HelperArgumentsTests(unittest.TestCase):
    def test_direct_and_warm_vk_cli_keep_negative_id_after_options(self):
        with tempfile.TemporaryDirectory() as temporary:
            options = ['--provider', 'vk', '--job-dir', temporary, '--cache-dir', temporary,
                       '--ffmpeg', str(Path(__file__)), '--lease', temporary + '/lease.json']
            job = ['fetch', '--cache-dir', temporary, '--height', '360', '--', '-123_456', temporary + '/video']
            with mock.patch.object(mediafetch.core, 'install_dns'), \
                 mock.patch.object(mediafetch, 'load_job', return_value=({}, None)), \
                 mock.patch.object(mediafetch, 'normalize') as normalize, \
                 mock.patch.object(mediafetch, '_OUT', io.StringIO()):
                mediafetch.main(options + job)
                self.assertEqual(normalize.call_args.args[0].id, '-123_456')
                self.assertEqual(normalize.call_args.args[0].height, 360)
                with mock.patch('sys.stdin', io.StringIO(json.dumps(job) + '\n')):
                    mediafetch.main(options + ['serve'])
                self.assertEqual(normalize.call_args.args[0].id, '-123_456')
                self.assertEqual(normalize.call_count, 2)

    def test_youtube_parser_accepts_the_same_daemon_separator(self):
        with mock.patch.object(mediafetch.core, 'proxy_from_file', return_value=None), \
             mock.patch.object(mediafetch.core, 'fetch') as fetch:
            mediafetch.core.main(['fetch', '--cache-dir', '/fixture/cache', '--height', '480',
                                  '--', '-abcdefghij', '/fixture/video'])
        self.assertEqual(fetch.call_args.args[0].id, '-abcdefghij')
        self.assertEqual(fetch.call_args.args[0].height, 480)


if __name__ == '__main__':
    unittest.main()
