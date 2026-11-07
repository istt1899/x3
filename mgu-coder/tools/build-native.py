"""Build Bimmer Code with the same SDK-free App Kit pipeline as VK/RUTUBE."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
KIT = REPO / 'media/core/kit'
APP_ID = 'marku_x3_coding'
APP = ROOT / 'native/apps' / APP_ID
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
OUT = ROOT / 'dist/publish/x3-coding'


def main():
    spec = json.loads((APP / 'app.json').read_text(encoding='utf-8'))
    if spec['id'] != APP_ID or spec['version'] != VERSION:
        raise ValueError('native app spec and project version differ')
    sys.path.insert(0, str(KIT / 'tools'))
    module = importlib.util.spec_from_file_location('bimmer_native_builder', KIT / 'tools/build.py')
    builder = importlib.util.module_from_spec(module)
    module.loader.exec_module(builder)
    with tempfile.TemporaryDirectory(prefix='bimmer-native-build-') as temporary:
        work = Path(temporary).resolve()
        assert work.parent == Path(tempfile.gettempdir()).resolve()
        builder.APPS = str(APP.parent)
        builder.DIST = str(work / 'dist')
        builder.build(APP_ID, source_only=True)
        source = Path(builder.DIST) / APP_ID / 'source'
        # Retain the existing diagnostic button's HMI speedlock declaration.
        # This is an additional HMI barrier, not an independent speed check.
        ui_path = source / 'rhmiData/uiDescriptions/ID7/uiDescription.json'
        ui = json.loads(ui_path.read_text(encoding='utf-8'))
        scan_ids = []
        for state in ui['containers'].values():
            for cid, component in state.get('components', {}).items():
                if component.get('name') == 'codingScan':
                    component.setdefault('properties', {})['Speedlockable'] = {'value': 1, 'type': 'UInt'}
                    scan_ids.append(cid)
        if len(scan_ids) != 1:
            raise ValueError('expected exactly one diagnostic action')
        ui_path.write_text(json.dumps(ui, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
        xml_path = source / 'rhmiData/uiDescriptions/ID7/application.xml'
        xml = ET.parse(xml_path)
        component = xml.find('.//component[@id="' + scan_ids[0] + '"]')
        ET.SubElement(component, 'property', {'id': '6', 'value': '1'})
        xml.write(xml_path, encoding='utf-8', xml_declaration=True)
        # Preserve installed application and launcher identities across updates.
        description_path = source / 'rhmiData/application.json'
        description = json.loads(description_path.read_text(encoding='utf-8'))
        description['application']['uuid'] = '38a8cc17-b988-4f3e-93f6-a0821e5d92f6'
        description['application']['entryPoints'][0]['uuid'] = '19354110-9606-41df-862e-bbdc5f1d9aa7'
        description_path.write_text(json.dumps(description, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
        package_path = source / 'package.json'
        package = json.loads(package_path.read_text(encoding='utf-8'))
        package.update(mguLocalOnly=True, mguHmi=['ID7'], productName='Bimmer Code')
        package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
        # No BMW SDK, linked bundle, or handwritten runner is distributed.
        if (source / 'node_modules').exists() or package['main'] != 'javascript/app.js':
            raise ValueError('native source package unexpectedly contains SDK or runner')
        OUT.mkdir(parents=True, exist_ok=True)
        target = OUT / f'{APP_ID}@{VERSION}.tgz'
        with target.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as archive:
                archive.add(source, arcname='package', filter=builder.stable_tar_info)
        evidence = {
            'schema': 1, 'id': APP_ID, 'version': VERSION, 'mode': 'App Kit module package',
            'sdkIncluded': False, 'vehicleRuntimeTested': False,
            'artifactSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
            'kitFiles': {str(p.relative_to(KIT)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in sorted((KIT / 'runtime').rglob('*')) if p.is_file() and '__pycache__' not in str(p)},
            'builderSha256': hashlib.sha256((KIT / 'tools/build.py').read_bytes()).hexdigest(),
        }
        (OUT / 'build-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8', newline='\n')
        print('Native App Kit package: ' + str(target))


if __name__ == '__main__':
    main()
