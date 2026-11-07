// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// Publish MGU Store releases after source has been pushed separately.
// Usage:
//   node publish-github.js --check
//   node publish-github.js --publish
// Optional: --assets DIR --owner USER --repo NAME --notes FILE --head SHA
//
// --check performs local validation and read-only GitHub checks. --publish is
// required for every write. Authentication comes from the already signed-in
// Git Credential Manager; the credential is never written to a file or log.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

if (Number(process.versions.node.split('.')[0]) < 18) {
  throw new Error('Node.js 18 or newer is required');
}

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = Object.freeze({
  owner: 'istt1899',
  repo: 'x3',
  assets: path.join(ROOT, 'dist', 'publish', 'x3-coding'),
  notes: path.join(ROOT, 'RELEASE-NOTES.md'),
  head: null
});
const API = 'https://api.github.com';
const USER_AGENT = 'BMW-MGU-publisher';

function parseArgs(argv) {
  const opts = { ...DEFAULTS, mode: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check' || arg === '--publish') {
      if (opts.mode) throw new Error('Choose exactly one of --check and --publish');
      opts.mode = arg.slice(2);
      continue;
    }
    const key = arg.slice(2);
    if (!arg.startsWith('--') || !['owner', 'repo', 'assets', 'notes', 'head'].includes(key)) {
      throw new Error('Unknown argument: ' + arg);
    }
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing value for ' + arg);
    opts[key] = argv[++i];
  }
  if (!opts.mode) throw new Error('Pass --check or --publish explicitly');
  if (!/^[A-Za-z0-9-]+$/.test(opts.owner) || !/^[A-Za-z0-9._-]+$/.test(opts.repo)) {
    throw new Error('Invalid GitHub owner or repository name');
  }
  opts.assets = path.resolve(opts.assets);
  opts.notes = path.resolve(opts.notes);
  if (!opts.head) opts.head = cp.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.dirname(ROOT), encoding: 'utf8', windowsHide: true
  }).trim();
  if (opts.head && !/^[0-9a-f]{40}$/i.test(opts.head)) throw new Error('Invalid expected main commit SHA');
  return opts;
}

function assertFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected regular file: ' + file);
  return stat;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertCatalogPreservesExisting(incoming, existing) {
  if (!existing) return;
  if (existing.schema !== 2 || !Array.isArray(existing.components)) throw new Error('Existing shared catalog is invalid');
  const ids = new Set(incoming.components.map(component => component.id));
  const missing = existing.components.map(component => component.id).filter(id => !ids.has(id));
  if (missing.length) {
    throw new Error('Refusing to remove other apps from the shared Store catalog: ' + missing.join(', ')
      + '. Publish a merged catalog that preserves them; the coding-only publisher cannot replace this shared catalog.');
  }
}

async function checkExistingCatalog(api, opts, incomingBytes) {
  const release = await releaseByTag(api, opts, 'catalog');
  const asset = release && release.assets.find(item => item.name === 'catalog.json');
  if (!asset) return;
  const url = new URL(asset.browser_download_url);
  url.searchParams.set('verify_asset', String(asset.id));
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error('Cannot check existing shared catalog before publishing');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) throw new Error('Existing shared catalog is too large');
  assertCatalogPreservesExisting(JSON.parse(incomingBytes.toString('utf8')), JSON.parse(bytes.toString('utf8')));
}

function loadCatalog(opts) {
  const file = path.join(opts.assets, 'catalog.github.json');
  assertFile(file);
  const catalogBytes = fs.readFileSync(file);
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  if (catalog.schema !== 2 || !Array.isArray(catalog.components) || catalog.components.length === 0) {
    throw new Error('Expected nonempty MGU Store schema-2 catalog');
  }
  const items = [];
  const seen = new Set();
  for (const component of catalog.components) {
    if (!/^[A-Za-z0-9_-]+$/.test(component.id) || !/^\d+\.\d+\.\d+$/.test(component.version)) {
      throw new Error('Invalid component ID or version');
    }
    const tag = `${component.id}@${component.version}`;
    const artifact = component.artifact;
    if (seen.has(tag) || !artifact || artifact.name !== `${tag}.tgz`) {
      throw new Error('Duplicate component or unexpected archive name: ' + tag);
    }
    seen.add(tag);
    const filePath = path.join(opts.assets, artifact.name);
    const stat = assertFile(filePath);
    const bytes = fs.readFileSync(filePath);
    if (stat.size !== artifact.size || sha256(bytes) !== artifact.sha256) {
      throw new Error('Archive size or SHA-256 differs from catalog: ' + artifact.name);
    }
    const expectedUrl = `https://github.com/${opts.owner}/${opts.repo}/releases/download/${tag}/${artifact.name}`;
    if (artifact.url !== expectedUrl) throw new Error('Build catalog.github.json for the requested repository before publishing');
    items.push({ component, tag, bytes });
  }
  // Publish the exact generated file bytes; no URL rewrite or serialization.
  return { items, catalogBytes };
}

function cachedCredential() {
  const result = cp.spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error('No noninteractive GitHub credential in Git Credential Manager');
  }
  const fields = new Map(result.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  if (!fields.get('username') || !fields.get('password')) {
    throw new Error('Git Credential Manager returned an incomplete GitHub credential');
  }
  return { username: fields.get('username'), token: fields.get('password') };
}

function assertCleanSource(opts, items, catalogBytes) {
  const repository = path.dirname(ROOT);
  const git = (args) => cp.execFileSync('git', args, { cwd: repository, windowsHide: true });
  const head = git(['rev-parse', 'HEAD']).toString('utf8').trim();
  if (head !== opts.head) throw new Error('Expected commit differs from local source HEAD');
  if (git(['status', '--porcelain', '--untracked-files=all']).toString('utf8').trim()) {
    throw new Error('Commit all source and generated assets before publishing; working tree is not clean');
  }
  const files = [{ name: 'catalog.github.json', bytes: catalogBytes }].concat(
    items.map(item => ({ name: item.component.artifact.name, bytes: item.bytes })));
  for (const file of files) {
    const relative = path.relative(repository, path.resolve(opts.assets, file.name));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
      throw new Error('Published assets must be tracked inside this source repository');
    }
    const committed = git(['show', 'HEAD:' + relative.split(path.sep).join('/')]);
    if (!committed.equals(file.bytes)) throw new Error('Asset differs from committed source: ' + file.name);
  }
}

function makeApi(token) {
  async function request(method, route, body, accept = 'application/vnd.github+json') {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT
    };
    let payload;
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) {
        payload = body;
        headers['Content-Type'] = 'application/octet-stream';
      } else {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }
    }
    const endpoint = route.startsWith('https://') ? route : API + route;
    const response = await fetch(endpoint, { method, headers, body: payload, redirect: 'follow' });
    if (response.status === 404) return { status: 404, data: null };
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    if (!response.ok) {
      const message = (typeof data === 'object' && data && data.message) || response.statusText;
      throw new Error(`GitHub API ${method} ${route} failed (${response.status}): ${String(message).replaceAll(token, '[REDACTED]')}`);
    }
    return { status: response.status, data };
  }
  return request;
}

async function repoState(api, opts) {
  const result = await api('GET', `/repos/${opts.owner}/${opts.repo}`);
  if (result.status === 404) return null;
  if (result.data.owner.login.toLowerCase() !== opts.owner.toLowerCase()) {
    throw new Error('Existing repository owner differs from requested owner');
  }
  if (result.data.private) throw new Error('Existing repository is private; will not change visibility');
  return result.data;
}

async function releaseByTag(api, opts, tag) {
  const result = await api('GET', `/repos/${opts.owner}/${opts.repo}/releases/tags/${encodeURIComponent(tag)}`);
  return result.status === 404 ? null : result.data;
}

async function ensureRelease(api, opts, tag, title, notes) {
  let release = await releaseByTag(api, opts, tag);
  if (!release) {
    const result = await api('POST', `/repos/${opts.owner}/${opts.repo}/releases`, {
      tag_name: tag, target_commitish: opts.head, name: title,
      body: notes, draft: false, prerelease: false
    });
    release = result.data;
    console.log('Created release: ' + tag);
  } else {
    console.log('Release exists: ' + tag);
  }
  if (release.tag_name !== tag || release.draft) throw new Error('Release tag or draft state differs: ' + tag);
  if (tag !== 'catalog') {
    const ref = await api('GET', `/repos/${opts.owner}/${opts.repo}/git/ref/tags/${encodeURIComponent(tag)}`);
    let object = ref.data && ref.data.object;
    for (let depth = 0; object && object.type === 'tag' && depth < 8; depth += 1) {
      const annotated = await api('GET', `/repos/${opts.owner}/${opts.repo}/git/tags/${object.sha}`);
      object = annotated.data && annotated.data.object;
    }
    if (!object || object.type !== 'commit' || object.sha !== opts.head) {
      throw new Error('Version tag does not point to the expected source commit: ' + tag);
    }
  }
  return release;
}

async function assetHash(asset) {
  // A replaced catalog keeps its public tag/name URL. Key verification by
  // immutable asset ID so a cached redirect cannot return the deleted asset.
  const download = new URL(asset.browser_download_url);
  download.searchParams.set('verify_asset', String(asset.id));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(download, {
      headers: { 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache' }, redirect: 'follow'
    });
    if (response.ok) return sha256(Buffer.from(await response.arrayBuffer()));
    if (![404, 429, 500, 502, 503, 504].includes(response.status) || attempt === 7) {
      throw new Error(`Cannot download release asset (${response.status}): ${asset.name}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
  }
}

async function uploadAsset(api, opts, release, name, bytes) {
  const route = `https://uploads.github.com/repos/${opts.owner}/${opts.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const uploaded = await api('POST', route, bytes);
  if (uploaded.data.name !== name || uploaded.data.size !== bytes.length) {
    throw new Error('Uploaded release asset metadata differs: ' + name);
  }
  return uploaded.data;
}

async function ensureImmutableAsset(api, opts, release, name, bytes) {
  const fresh = await releaseByTag(api, opts, release.tag_name);
  const existing = fresh.assets.find(asset => asset.name === name);
  if (existing) {
    if (existing.size !== bytes.length || await assetHash(existing) !== sha256(bytes)) {
      throw new Error('Immutable release asset already exists with different bytes: ' + name);
    }
    console.log('Verified existing version asset: ' + name);
    return;
  }
  const uploaded = await uploadAsset(api, opts, release, name, bytes);
  if (await assetHash(uploaded) !== sha256(bytes)) throw new Error('Uploaded version asset failed SHA-256 verification');
  console.log('Uploaded and verified version asset: ' + name);
}

async function ensureCatalogAsset(api, opts, release, bytes) {
  const name = 'catalog.json';
  const expectedHash = sha256(bytes);
  const fresh = await releaseByTag(api, opts, release.tag_name);
  let existing = fresh.assets.find(asset => asset.name === name);
  if (existing && existing.size === bytes.length && await assetHash(existing) === expectedHash) {
    console.log('Verified existing catalog.json');
    return;
  }
  if (!existing) {
    const tempName = `catalog.${expectedHash.slice(0, 16)}.json`;
    const pending = fresh.assets.find(asset => asset.name === tempName);
    if (pending) {
      if (pending.size !== bytes.length || await assetHash(pending) !== expectedHash) {
        throw new Error('Pending catalog asset exists with different bytes');
      }
      const renamed = await api('PATCH', `/repos/${opts.owner}/${opts.repo}/releases/assets/${pending.id}`, { name });
      if (renamed.data.name !== name || await assetHash(renamed.data) !== expectedHash) {
        throw new Error('Recovered catalog failed verification');
      }
      console.log('Recovered and verified catalog.json');
      return;
    }
    const uploaded = await uploadAsset(api, opts, release, name, bytes);
    if (await assetHash(uploaded) !== expectedHash) throw new Error('Uploaded catalog failed SHA-256 verification');
    console.log('Uploaded and verified catalog.json');
    return;
  }
  // For an update, upload and verify the replacement before removing the old
  // catalog. A rerun can resume if interrupted between these API calls.
  const tempName = `catalog.${expectedHash.slice(0, 16)}.json`;
  let replacement = fresh.assets.find(asset => asset.name === tempName);
  if (replacement) {
    if (replacement.size !== bytes.length || await assetHash(replacement) !== expectedHash) {
      throw new Error('Temporary catalog asset exists with different bytes');
    }
  } else {
    replacement = await uploadAsset(api, opts, release, tempName, bytes);
    if (await assetHash(replacement) !== expectedHash) throw new Error('Temporary catalog failed SHA-256 verification');
  }
  await api('DELETE', `/repos/${opts.owner}/${opts.repo}/releases/assets/${existing.id}`);
  const renamed = await api('PATCH', `/repos/${opts.owner}/${opts.repo}/releases/assets/${replacement.id}`, { name });
  if (renamed.data.name !== name || await assetHash(renamed.data) !== expectedHash) {
    throw new Error('Replacement catalog failed verification');
  }
  console.log('Updated and verified catalog.json');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { items, catalogBytes } = loadCatalog(opts);
  if (opts.mode === 'publish') assertCleanSource(opts, items, catalogBytes);
  const credential = cachedCredential();
  const api = makeApi(credential.token);
  const user = await api('GET', '/user');
  if (user.data.login.toLowerCase() !== opts.owner.toLowerCase()) {
    throw new Error(`Signed-in GitHub account ${user.data.login} differs from requested owner ${opts.owner}`);
  }
  const existingRepo = await repoState(api, opts);
  console.log(`GitHub account: ${user.data.login}; repository: ${opts.owner}/${opts.repo}`);
  console.log(`Archives: ${items.map(item => item.component.artifact.name).join(', ')}`);
  console.log(`Catalog SHA-256: ${sha256(catalogBytes)}`);
  console.log(`Repository state: ${existingRepo ? 'public and existing' : 'absent'}`);
  if (opts.mode === 'check') {
    for (const item of items) {
      const release = await releaseByTag(api, opts, item.tag);
      console.log(`Version release ${item.tag}: ${release ? 'existing' : 'absent'}`);
    }
    const catalogRelease = await releaseByTag(api, opts, 'catalog');
    console.log(`Catalog release: ${catalogRelease ? 'existing' : 'absent'}`);
    console.log('Read-only check complete. Pass --publish to publish.');
    return;
  }
  const notes = fs.existsSync(opts.notes)
    ? fs.readFileSync(opts.notes, 'utf8')
    : 'Experimental BMW X3 MGU coding catalogue and read-only ECU diagnostics. Vehicle validation is pending.';
  if (!existingRepo) throw new Error('Repository is absent; push source before publishing releases');
  const mainCommit = await api('GET', `/repos/${opts.owner}/${opts.repo}/commits/main`);
  if (mainCommit.status === 404 || (opts.head && mainCommit.data.sha !== opts.head)) {
    throw new Error('GitHub main commit does not match the expected source commit');
  }
  console.log('Verified GitHub main commit: ' + mainCommit.data.sha);
  await checkExistingCatalog(api, opts, catalogBytes);
  for (const item of items) {
    const release = await ensureRelease(api, opts, item.tag, `${item.component.id} ${item.component.version}`, notes);
    await ensureImmutableAsset(api, opts, release, item.component.artifact.name, item.bytes);
  }
  const catalogRelease = await ensureRelease(api, opts, 'catalog', 'MGU Store catalog',
    `Install source: ${opts.owner}/${opts.repo}, channel Releases.`);
  await ensureCatalogAsset(api, opts, catalogRelease, catalogBytes);
  const verifiedCatalog = await releaseByTag(api, opts, 'catalog');
  const catalogAsset = verifiedCatalog.assets.find(asset => asset.name === 'catalog.json');
  if (!catalogAsset || await assetHash(catalogAsset) !== sha256(catalogBytes)) {
    throw new Error('Final GET verification of catalog.json failed');
  }
  console.log(`Published and verified: https://github.com/${opts.owner}/${opts.repo}`);
  console.log(`Catalog: ${catalogAsset.browser_download_url}`);
}

if (require.main === module) main().catch(error => {
  // All errors are deliberately composed without credential values.
  console.error('publish-github: ' + error.message);
  process.exitCode = 1;
});

module.exports = { loadCatalog, assertCleanSource, assertCatalogPreservesExisting };
