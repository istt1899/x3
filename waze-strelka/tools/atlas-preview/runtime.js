(async function() {
'use strict';
const modules = Object.create(null), cache = Object.create(null);
const assets = /*ASSETS*/, config = /*CONFIG*/;
/*MODULES*/
const planes = new Map();
const unique = new Set(Object.values(assets).flatMap(font => font.sizes.map(s => s.alpha)));
await Promise.all(Array.from(unique, async encoded => {
    const compressed = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'));
    planes.set(encoded, new Uint8Array(await new Response(stream).arrayBuffer()));
}));
// The application keeps decoding synchronous after startup. Only bundled font
// data and the project's in-memory raster buffers are exposed by this adapter.
const buffer = {alloc: size => new Uint8Array(size), from: encoded => encoded};
const builtins = {
    'path': {join: (...parts) => parts.join('/')},
    'fs': {existsSync: () => true, readFileSync: path => {
        const key = path.split('/').pop().replace(/\.json$/, '');
        if (!assets[key]) throw Error('Нет шрифта ' + key);
        return JSON.stringify(assets[key]);
    }},
    'zlib': {inflateSync: encoded => {
        const bytes = planes.get(encoded);
        if (!bytes) throw Error('Не загружен растр шрифта');
        return bytes;
    }},
    'app/atlas-kit/renderd': {}, 'app/atlas-kit/record': {}, 'app/qr': {}, 'output/cluster_render_client': {},
    'kit/locale.json': {language:'ru',strings:{}}, 'output/camera-font.json':assets['camera-font']
};
function load(key) {
    key = key.replace(/\.js$/, '').replace('app/atlas-kit/canvas','kit/canvas');
    if (Object.hasOwn(builtins,key)) return builtins[key];
    if (Object.hasOwn(cache,key)) return cache[key].exports;
    if (!modules[key]) throw Error('Нет локального модуля ' + key);
    const entry = {exports:{}}, dir = key.slice(0,key.lastIndexOf('/'));
    cache[key]=entry;
    modules[key](name=>load(name.startsWith('./')?dir+'/'+name.slice(2):name),entry,entry.exports,dir,buffer);
    return entry.exports;
}
/*APPLICATION*/
})().catch(err => {document.getElementById('notice').textContent='Ошибка симулятора: '+err.message; console.error(err);});
