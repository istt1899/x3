// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// Deterministic source metadata for the MGU Store source-package builder.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'marku_x3_coding');
const VERSION = require('../package.json').version;
const TREE = path.join(APP, 'marku_x3_coding@' + VERSION);
const RHMI = path.join(TREE, 'rhmiData');
const SID = 'SID_MARKU_X3_CODING_TITLE';
const TITLE = 'Bimmer Code';
const TEXTS = { [SID]: TITLE };
const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}
const defs = [
  [10, 'codingTitle', 'title', TITLE, true],
  [20, 'codingStatus', 'label', 'Диагностика ещё не запущена', true],
  [21, 'codingGate', 'label', 'Чтение блоков; запись пока недоступна', true],
  [30, 'codingScan', 'button', 'Проверить блоки на стоянке', true],
  [22, 'codingPage', 'label', 'Функции 1–5 из 10', true],
  [31, 'codingSlot1', 'button', 'Старт-стоп  ·  DME', true],
  [32, 'codingSlot2', 'button', 'Режим при запуске  ·  BDC_BODY3', true],
  [33, 'codingSlot3', 'button', 'Сигнал ремня  ·  ACSM5', true],
  [34, 'codingSlot4', 'button', 'Цвета подсветки  ·  BDC_BODY3', true],
  [35, 'codingSlot5', 'button', 'Складывание зеркал  ·  BDC_BODY3', true],
  [36, 'codingPrev', 'button', 'Предыдущие функции', false],
  [37, 'codingNext', 'button', 'Следующие функции', true],
  [40, 'detailEcu', 'label', 'Блок', false],
  [41, 'detailSummary', 'label', 'Описание', false],
  [42, 'detailRequirement', 'label', 'Условие', false],
  [43, 'detailCaution', 'label', 'Проверить', false],
  [44, 'detailStatus', 'label', 'Доступность не проверена', false],
  [45, 'codingBack', 'button', 'К списку функций', false],
  [23, 'codingFooter', 'label', 'Только на стоянке; скорость приложением не проверяется', true]
];

function makeRhmi() {
  const state = { type: 'state', name: 'ST_OnlineApps_MarkuX3Coding', components: {} };
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>',
    '  <container id="1" type="state" widget="LT_State_Wide">',
    '    <layoutGroup id="100" name="Titlebar">'];
  function component(def) {
    const [id, name, type, value, visible] = def;
    const textId = 'SID_MARKU_X3_' + name.toUpperCase();
    TEXTS[textId] = value;
    const props = { Visible: { value: visible ? 1 : 0, type: 'UInt' },
      Focusable: { value: type === 'button' ? 3 : 0, type: 'UInt' } };
    if (name === 'codingScan') props.Speedlockable = { value: 1, type: 'UInt' };
    state.components[String(id)] = { type, name,
      rows: [{ Text: { value: textId, type: 'StringId' } }] };
    if (type === 'title') {
      // Match the title component shape emitted by the working App Kit.
      lines.push('      <component id="' + id + '" type="title"/>');
      return;
    }
    state.components[String(id)].properties = props;
    const widget = type === 'title' ? '' :
      ' widget="' + (type === 'button' ? 'LT_Button_1Row' : 'LT_Label_1Row') + '"';
    lines.push('      <component id="' + id + '" type="' + type + '"' + widget + '>');
    lines.push('        <property id="2" value="' + (visible ? 1 : 0) + '"/>');
    lines.push('        <property id="3" value="' + (type === 'button' ? 3 : 0) + '"/>');
    if (name === 'codingScan') lines.push('        <property id="6" value="1"/>');
    lines.push('      </component>');
  }
  component(defs[0]);
  lines.push('    </layoutGroup>', '    <layoutGroup id="200" name="List">',
    '      <property id="3" value="1"/>');
  defs.slice(1).forEach(component);
  lines.push('    </layoutGroup>', '  </container>', '</application>', '');
  write(path.join(RHMI, 'uiDescriptions', 'ID7', 'application.xml'), lines.join('\n'));
  write(path.join(RHMI, 'uiDescriptions', 'ID7', 'uiDescription.json'),
    { schemaVersion: '1.3.0', containers: { 1: state } });
  const application = {
    schemaVersion: '1.3.0', application: {
      uuid: '38a8cc17-b988-4f3e-93f6-a0821e5d92f6', type: 'OnlineApp',
      name: 'marku_x3_coding', vendor: 'Marku local project', version: VERSION,
      defaultLanguage: 'en_GB',
      uiDescriptions: [{ applicationFilePath: './uiDescriptions/ID7/application.xml',
        uiDescriptionFilePath: './uiDescriptions/ID7/uiDescription.json', hmi: ['ID7'] }],
      stringBundleUuid: 'e071cb80-8914-4c76-a33d-820f9b0eea44',
      resourceBundleUuid: '11329cec-717e-48ab-87e5-59c795cdb158',
      variantGroups: [{ stringsPath: './variantGroups/Common/texts',
        resourcesPath: './variantGroups/Common/images', hmi: ['ID7'], brands: ['BMW'] }],
      entryPoints: [{ name: 'marku_x3_coding', uuid: '19354110-9606-41df-862e-bbdc5f1d9aa7',
        textId: SID, icon: 'x3_coding.png', insertionStateId: 20974,
        insertionFocusId: 2, insertionMode: 'INSERT_BELOW', insertionOrder: 0,
        insertionPriority: 0, previewType: 'NONE', bookmarkable: true,
        private: false, appearance: 'DEFAULT', isGroupHeader: false, insertionGroup: 0 }]
    }
  };
  write(path.join(RHMI, 'application.json'), application);
  ['ru_RU', 'en_GB'].forEach((lang) => write(path.join(RHMI, 'variantGroups', 'Common', 'texts', lang + '.json'),
    TEXTS));
}

function makePackage() {
  // Match the SDK configuration used by the working VK/RUTUBE App Kit
  // packages. Some donor SDKs default both loaders to false.
  write(path.join(TREE, 'config', 'base.json'), {
    rhmiLoadingEnabled: true, entryPointLoadingEnabled: true,
    settings: { marku_x3_coding: {} }
  });
  write(path.join(APP, 'mgu-app.json'), {
    schema: 1, id: 'marku_x3_coding', version: VERSION, tree: 'marku_x3_coding@' + VERSION,
    mguHmi: ['ID7'], modules: ['src/coding_app.js', 'src/catalog.js', 'src/view_model.js',
      'src/diagnostics.js', 'src/someip_signals.js'],
    sdk: ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging']
  });
  write(path.join(APP, 'release.json'), {
    build: 'node ../../tools/build.js', requires: { 'mgu-deploy': '0.7.11' },
    uninstallable: true, mguHmi: ['ID7']
  });
  write(path.join(TREE, 'package.json'), {
    name: 'marku_x3_coding', version: VERSION,
    description: 'X3 G01 coding research catalogue and read-only ECU discovery for BMW ID7',
    private: false, main: 'javascript/runner.js',
    oapAppSettings: { maxDiskUsage: 10485760, cpuLimit: 15, memoryThresholdKB: 65536,
      priority: 'PRIO_MEDIUM', visibility: 'FOREGROUND', latencyClass: 'FOREGROUND',
      loggingId: 'MX3C', userLoginRequired: false, backgroundPriority: 150,
      someipManifest: 'manifest.json' },
    files: ['config', 'rhmiData', 'package.json', 'npm-shrinkwrap.json',
      'permissions.json', 'javascript', 'manifest.json', 'LICENSE', 'LICENSE.MIT', 'NOTICE'],
    dependencies: { 'oap-sdk': '24.10.2' }, engines: { node: '>=8.7.0' },
    author: 'Marku custom local project', license: 'GPL-3.0-or-later',
    mguLocalOnly: true, productName: TITLE, mguHmi: ['ID7']
  });
  write(path.join(TREE, 'npm-shrinkwrap.json'),
    { name: 'marku_x3_coding', version: VERSION, lockfileVersion: 1 });
  const manifest = JSON.parse(fs.readFileSync(path.join(TREE, 'manifest.json'), 'utf8'));
  manifest.proxies[IFACE] = { instances: 'SystemFunctionsInternalTasuInst1',
    methods: ['sendTasuRequest'], broadcasts: ['sendTasuResponse'] };
  write(path.join(TREE, 'manifest.json'), manifest);
  write(path.join(TREE, 'NOTICE'),
    'Bimmer Code ' + VERSION + '\nApplication: GPL-3.0-or-later.\n' +
    'RHMI lifecycle adapted from the GPL-3.0-or-later Kaluga Cameras project.\n' +
    'Diagnostic request and transport shape studied from the MIT-licensed cauliflowermossgrape/idrive7-apps project; see LICENSE.MIT.\n' +
    'No BMW SDK, proprietary CAFD/NCD mappings, vehicle identifiers or BimmerCode code/data are included.\n');
}

function main() { makeRhmi(); makePackage(); }
if (require.main === module) main();
module.exports = { main, defs };
