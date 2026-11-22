'use strict';
const crypto = require('crypto');
const zlib = require('zlib');
const selection = require('./speedcam-selection.json');

// The row numbers in the review apply to exactly this release.
const SOURCE = Object.freeze({
    url: 'https://github.com/korableg/openneodb/releases/download/russia-2026-11-01/neoline_x-cop_9000c_russia_2026-11-01.zip',
    bytes: 594208,
    sha256: '17cd02ecb62ede52e3ed09c65789a99a6bfc8f77e1670d8ae8469d93c2c6da31',
    version: '2026.11.1',
    packSha256: '6f5dd302f334cccbcf0e9047dad6d276ce0ab964bf82ccc57b5e78619305939b'
});

// On-disk format: github.com/korableg/openneodb, db/writer.py at bb2c344.
const HEADER_BYTES = 0x440;
const RECORD_BYTES = 24;
const RECORD_MASK = Buffer.from('a3aecb2c7d9980464a0013ad8a3a563c0c5a08733b6fef78', 'hex');

function digest(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function extractDatabase(zip) {
    if (!Buffer.isBuffer(zip) || zip.length !== SOURCE.bytes || digest(zip) !== SOURCE.sha256) {
        throw new Error('SPEEDCAM_SOURCE_HASH');
    }
    // The pinned ZIP starts with one deflated file, whose sizes are in the local header.
    const nameEnd = 30 + zip.readUInt16LE(26);
    const start = nameEnd + zip.readUInt16LE(28);
    const compressedSize = zip.readUInt32LE(18);
    const size = HEADER_BYTES + selection.inputRows * RECORD_BYTES;
    if (zip.readUInt32LE(0) !== 0x04034b50 || zip.readUInt16LE(6) !== 0 || zip.readUInt16LE(8) !== 8 ||
        zip.toString('ascii', 30, nameEnd) !== 'X-COP_9000c_Baza_GPS.db' ||
        zip.readUInt32LE(22) !== size || start + compressedSize > zip.length) {
        throw new Error('SPEEDCAM_SOURCE_ZIP');
    }
    const db = zlib.inflateRawSync(zip.slice(start, start + compressedSize));
    if (db.length !== size || db.readUInt32LE(0x430) !== selection.inputRows) {
        throw new Error('SPEEDCAM_SOURCE_DB');
    }
    return db;
}

// Preserve the Python reference pack's decimal representation of integer coordinates.
function jsonCoordinate(value) {
    return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

// Pure conversion for the update worker. Returns the checked UTF-8 JSON file bytes.
function buildPack(zip) {
    const db = extractDatabase(zip);
    const include = Buffer.from(selection.includeLsbFirst, 'base64');
    if (include.length !== Math.ceil(selection.inputRows / 8)) throw new Error('SPEEDCAM_SELECTION');
    const rows = [];
    const raw = Buffer.alloc(RECORD_BYTES);
    for (let index = 0; index < selection.inputRows; index++) {
        if (!(include[index >> 3] & (1 << (index & 7)))) continue;
        const start = HEADER_BYTES + index * RECORD_BYTES;
        for (let byte = 0; byte < RECORD_BYTES; byte++) raw[byte] = db[start + byte] ^ RECORD_MASK[byte];
        const lat = raw.readUInt32BE(1) / 10000;
        const lon = raw.readUInt32BE(5) / 10000;
        const course = raw.readUInt16BE(9);
        const speed = raw[12] || null;
        const type = raw[0];
        const link = selection.links[index + 1];
        const id = link && link[1] || 'sco:' + digest(lat.toFixed(4) + '/' + lon.toFixed(4) + '/' + course).slice(0, 20);
        const target = link ? link[0] : null;
        rows.push(['[' + JSON.stringify(id), jsonCoordinate(lat), jsonCoordinate(lon), course,
            JSON.stringify(speed), JSON.stringify(target), type + ']'].join(','));
    }
    if (rows.length !== selection.outputRows) throw new Error('SPEEDCAM_SELECTION_COUNT');
    // All IDs have the same fixed width and are the first field, so this orders by ID.
    rows.sort();
    const header = {schema: 1, source: 'speedcamonline', version: SOURCE.version, directionMeaning: 'vehicle-course'};
    const pack = Buffer.from(JSON.stringify(header).slice(0, -1) + ',"records":[' + rows.join(',') + ']}\n');
    if (digest(pack) !== SOURCE.packSha256) throw new Error('SPEEDCAM_PACK_HASH');
    return pack;
}

module.exports = { SOURCE, buildPack };
