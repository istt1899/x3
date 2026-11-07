import contextlib
import io
import tempfile
from pathlib import Path
import unittest
from unittest import mock

import network_probe as probe


class Response(io.BytesIO):
    status = 200


class ProbeTest(unittest.TestCase):
    def config(self, speed=True, provider='rutube'):
        return {'source': 'external', 'provider': provider, 'speed': speed,
                'leaseFile': 'fixture', 'caFile': 'fixture-ca'}

    def run_probe(self, config, service_fails=False, speed_fails=False):
        reads = []
        def open_url(request, timeout):
            reads.append(request.full_url)
            if len(reads) == 1:
                if speed_fails:
                    raise OSError('fixture timeout with sensitive URL must never escape')
                return Response(b'x' * (probe.LIMIT + 8192))
            if service_fails:
                raise OSError('secret provider token must never escape')
            return Response(b'ok')
        clock = iter(i * 0.05 for i in range(1000))
        with mock.patch.object(probe.ytfetch, 'lease_servers', return_value=['192.0.2.1']), \
             mock.patch.object(probe.ytfetch, 'install_dns'), \
             mock.patch.object(probe.ssl, 'create_default_context'), \
             mock.patch.object(probe.urllib.request, 'build_opener') as builder:
            builder.return_value.open.side_effect = open_url
            result = probe.perform(config, now=lambda: next(clock))
        return result, reads

    def test_download_bounded_and_no_automatic_selection(self):
        result, urls = self.run_probe(self.config())
        self.assertTrue(result['ok'])
        self.assertEqual(result['bytes'], probe.LIMIT)
        self.assertGreater(result['downloadMbps'], 0)
        self.assertTrue(result['serviceAvailable'])
        self.assertEqual(len(urls), 2)

    def test_fast_cdn_does_not_prove_provider_access(self):
        result, _ = self.run_probe(self.config(), service_fails=True)
        self.assertFalse(result['ok'])
        self.assertFalse(result['serviceAvailable'])
        self.assertNotIn('secret', str(result))

    def test_selection_does_not_require_speed_cdn(self):
        result, _ = self.run_probe(self.config(speed=False), speed_fails=True)
        self.assertTrue(result['ok'])
        self.assertTrue(result['serviceAvailable'])

    def test_missing_dns_never_uses_system_fallback(self):
        with mock.patch.object(probe.ytfetch, 'lease_servers', return_value=[]), \
             mock.patch.object(probe.urllib.request, 'build_opener') as opener:
            self.assertFalse(probe.perform(self.config())['ok'])
            opener.assert_not_called()

    def test_probe_uses_existing_youtube_proxy_only_for_provider(self):
        config = self.config(provider='youtube')
        config['proxy'] = 'http://fixture.invalid:3128'
        with mock.patch.object(probe.ytfetch, 'url_opener') as proxy:
            proxy.return_value.open.return_value = Response(b'YouTube')
            result, urls = self.run_probe(config)
            self.assertTrue(result['serviceAvailable'])
            self.assertEqual(len(urls), 1, 'baseline download remains direct')
            self.assertEqual(proxy.call_args[0][1]['host'], 'fixture.invalid')


if __name__ == '__main__':
    unittest.main()
