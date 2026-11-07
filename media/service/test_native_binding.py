import socket
import unittest
from unittest import mock
import network_probe
import network_native


class FakeSocket:
    family = socket.AF_INET
    def __init__(self):
        self.bound = None
        self.connected = None
    def getsockname(self):
        return self.bound or ('0.0.0.0', 0)
    def bind(self, address):
        self.bound = address
    def connect(self, address):
        self.connected = address
    def connect_ex(self, address):
        self.connected = address
        return 0
    def sendto(self, payload, address):
        self.connected = address
        return len(payload)


class NativeBindingTest(unittest.TestCase):
    def test_selected_source_binds_tcp_and_dns_without_fallback(self):
        with mock.patch.object(socket, 'socket', FakeSocket), \
             mock.patch.object(network_native.os, 'getuid', return_value=15002, create=True), \
             mock.patch.object(network_native.subprocess, 'check_output', return_value='1.1.1.1 dev eth2 src 10.0.0.2') as route:
            network_native.install({'networkSource':'builtin', 'ip':'10.0.0.2', 'interface':'eth2'})
            tcp = socket.socket()
            tcp.connect(('1.1.1.1', 443))
            self.assertEqual(tcp.bound, ('10.0.0.2', 0))
            self.assertEqual(route.call_args[0][0][-1], '15002')
            dns = socket.socket()
            self.assertEqual(dns.sendto(b'query', ('10.0.0.1', 53)), 5)
            self.assertEqual(dns.bound, ('10.0.0.2', 0))
            route.return_value = '1.1.1.1 dev wlan1 src 172.20.10.2'
            failed = socket.socket()
            with self.assertRaisesRegex(OSError, 'route changed'):
                failed.connect(('1.1.1.1', 443))
            self.assertIsNone(failed.connected)


if __name__ == '__main__':
    unittest.main()
