// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function main() {
  const app = path.join(__dirname, '..', 'apps', 'marku_x3_coding');
  const source = fs.readFileSync(path.join(app, 'icon.svg'), 'utf8');
  const target = path.join(app, 'marku_x3_coding@0.1.0', 'rhmiData', 'variantGroups',
    'Common', 'images', 'x3_coding.png');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const chrome = process.env.MGU_ICON_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await chromium.launch({ headless: true,
    executablePath: fs.existsSync(chrome) ? chrome : undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
    await page.setContent('<html><body style="margin:0;background:transparent">' + source + '</body></html>');
    await page.locator('svg').screenshot({ path: target, omitBackground: true });
  } finally { await browser.close(); }
  console.log(target);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
