#!/usr/bin/env python3
"""Verify the shipped remuxer's ELF ABI and pinned build provenance without executing it.

This can reject incompatible ELF files on Windows. It does not replace executing
FFmpeg's remux tests on Linux and on the actual MGU/kernel.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct


def inspect_elf(data):
    if len(data) < 64 or data[:4] != b'\x7fELF' or data[4:7] != b'\x02\x01\x01':
        raise ValueError('expected ELF64 little-endian version 1')
    header = struct.unpack_from('<16sHHIQQQIHHHHHH', data)
    _, elf_type, machine, _, entry, phoff, _, _, _, phentsize, phnum, _, _, _ = header
    if machine != 62 or elf_type not in (2, 3):
        raise ValueError('expected an x86-64 executable or static PIE')
    if phentsize < 56 or phnum > 256 or phoff + phentsize * phnum > len(data):
        raise ValueError('invalid ELF program headers')
    needed = []
    executable_stack = False
    load_segments = 0
    for i in range(phnum):
        kind, flags, offset, _, _, size, _, _ = struct.unpack_from('<IIQQQQQQ', data, phoff + i * phentsize)
        if offset + size > len(data):
            raise ValueError('ELF segment extends past end of file')
        if kind == 3:
            raise ValueError('PT_INTERP present: dynamic linker would be required on MGU')
        if kind == 1:
            load_segments += 1
        if kind == 2:
            for at in range(offset, offset + size - 15, 16):
                tag, value = struct.unpack_from('<QQ', data, at)
                if tag == 0:
                    break
                if tag == 1:
                    needed.append(value)
        if kind == 0x6474e551 and flags & 1:
            executable_stack = True
    if needed:
        raise ValueError('DT_NEEDED present: binary is not self-contained')
    if executable_stack:
        raise ValueError('FFmpeg requests an executable stack')
    if not load_segments or not entry:
        raise ValueError('ELF has no loadable executable image')
    if b'GLIBC_' in data:
        raise ValueError('GLIBC version symbols found; musl build required')
    return {'format': 'ELF64-LE', 'machine': 'x86_64', 'static': True,
            'interpreter': None, 'needed_libraries': [], 'glibc_version_symbols': False,
            'executable_stack': False, 'type': 'EXEC' if elf_type == 2 else 'DYN'}


def verify(file, manifest=None, config_dir=None):
    data = Path(file).read_bytes()
    result = inspect_elf(data)
    digest = hashlib.sha256(data).hexdigest()
    result.update(sha256=digest, size=len(data))
    if manifest:
        document = json.loads(Path(manifest).read_text(encoding='utf-8'))
        artifact = document['binary']
        if artifact['sha256'] != digest or artifact['size'] != len(data):
            raise ValueError('binary does not match the pinned build manifest')
        if document['license'] != 'LGPL-2.1-or-later' or document['target'] != 'x86_64-linux.3.2.0-musl':
            raise ValueError('unexpected runtime license or target')
    if config_dir:
        config = (Path(config_dir) / 'config.h').read_text(encoding='utf-8')
        for name in ['GPL', 'VERSION3', 'NONFREE', 'NETWORK', 'SHARED']:
            if f'#define CONFIG_{name} 0' not in config:
                raise ValueError(f'CONFIG_{name} must be disabled')
        if '#define CONFIG_STATIC 1' not in config:
            raise ValueError('static libraries must be enabled')
        if '#define HAVE_X86ASM 0' not in config:
            raise ValueError('external x86 assembler must be disabled')
        if 'LGPL version 2.1 or later' not in config:
            raise ValueError('generated FFmpeg license is not LGPL 2.1+')
        result['configuration_checked'] = True
    result['runtime_execution_proven'] = False
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('file', nargs='?', default=str(Path(__file__).with_name('ffmpeg')))
    ap.add_argument('--manifest')
    ap.add_argument('--config-dir')
    args = ap.parse_args()
    print(json.dumps(verify(args.file, args.manifest, args.config_dir), indent=2))


if __name__ == '__main__':
    main()
