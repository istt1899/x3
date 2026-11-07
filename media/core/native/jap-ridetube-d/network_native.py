"""Bind native-channel sockets to the verified BMW source and reject changed routes."""
import ipaddress
import os
import socket
import subprocess


def install(config):
    if config.get('networkSource') != 'builtin':
        return
    source = str(ipaddress.IPv4Address(config['ip']))
    interface = config['interface']
    original = socket.socket
    if getattr(original, '_mgu_native', None) == (source, interface):
        return

    class NativeSocket(original):
        _mgu_native = (source, interface)

        def _native(self, address):
            if self.family == getattr(socket, 'AF_UNIX', -1):
                return
            if self.family != socket.AF_INET:
                raise OSError('Native channel requires IPv4')
            ip = str(ipaddress.IPv4Address(address[0]))
            words = subprocess.check_output(['/sbin/ip', '-4', 'route', 'get', ip,
                'uid', str(os.getuid())], timeout=2, text=True).split()
            if 'dev' not in words or words[words.index('dev') + 1] != interface:
                raise OSError('Native route changed')
            if self.getsockname()[0] == '0.0.0.0':
                self.bind((source, 0))

        def connect(self, address):
            self._native(address)
            return super().connect(address)

        def connect_ex(self, address):
            self._native(address)
            return super().connect_ex(address)

        def sendto(self, *args):
            self._native(args[-1])
            return super().sendto(*args)

    socket.socket = NativeSocket
