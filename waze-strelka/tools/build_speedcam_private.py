"""Build a private, directional camera overlay from a local SpeedCam reconciliation.

Inputs are the national comparison CSV, the current Pulse export, a country
boundary, the source's live-card CSV, and a local CSV of reviewed uuid,target
relations. The latter identifies approaches to an existing intersection. All
source data and the resulting overlay stay outside the public source tree.
"""
import argparse
import base64
import csv
import hashlib
import json
import math
import os
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

SUPPORTED_TYPES = {1, 6, 12}
METRES_PER_DEGREE = 111195


class Locations:
    """Spatial index for short-distance neighborhood queries."""
    def __init__(self):
        self.grid = defaultdict(list)

    def add(self, lat, lon, key):
        self.grid[math.floor(lat * 100), math.floor(lon * 100)].append((lat, lon, key))

    def near(self, lat, lon, metres):
        cosine = math.cos(math.radians(lat))
        reach = math.ceil(metres / (METRES_PER_DEGREE / 100 * max(0.001, cosine)))
        y, x = math.floor(lat * 100), math.floor(lon * 100)
        for i in range(y - 1, y + 2):
            for j in range(x - reach, x + reach + 1):
                for other_lat, other_lon, key in self.grid.get((i, j), ()):
                    distance = METRES_PER_DEGREE * math.hypot(other_lat - lat, (other_lon - lon) * cosine)
                    if distance <= metres:
                        yield distance, key


def course_diff(a, b):
    return abs((a - b + 180) % 360 - 180)


def eligible(row):
    return (int(row['тип_код']) in SUPPORTED_TYPES
            and row['режим_направления'] == '1'
            and int(row['флаги']) in (0, 2)
            and row['курс_град'] and 0 <= int(row['курс_град']) < 360
            and not row['широта_конца'] and not row['долгота_конца'])


def known_limits(cam):
    speed = (cam.get('speedLimitEvidence') or {}).get('valueKmh')
    return {x for x in (cam.get('limitKmh'), speed) if x is not None}


def aligns(cam, course, speed):
    if cam.get('cameraLimitConditional') or cam.get('type') == 'mobile':
        return False
    known = known_limits(cam)
    flow = (cam.get('capture') or {}).get('flowDeg')
    return (not known or known == {speed}) and (flow is None or course_diff(course, flow) <= 20)


def read_csv(path):
    with path.open(encoding='utf-8-sig', newline='') as file:
        return list(csv.DictReader(file))


def build(rows, pulse, cards, reviewed, in_country, selection=None):
    by_id = {cam['id']: cam for cam in pulse}
    base = Locations()
    for cam in pulse:
        base.add(cam['position']['lat'], cam['position']['lon'], cam['id'])
    by_line = {r['строка_архива']: r for r in rows}
    if len(by_line) != len(rows) or len(by_id) != len(pulse):
        raise ValueError('Repeated source identifier')
    removed = set()
    approved = {}
    confirmed = set()
    for card in cards:
        lines = set(filter(None, card['строки_архива_в_ячейке'].split(',')))
        if card['статус'] == 'удалено':
            removed.update(lines)
            continue
        uid = card['UUID']
        if card['статус'] != 'на карте' or uid not in reviewed:
            continue
        target = reviewed[uid]
        lat, lon = float(card['широта']), float(card['долгота'])
        neighbors = list(base.near(lat, lon, 75))
        if (len(neighbors) != 1 or neighbors[0][1] != target or neighbors[0][0] > 30
                or card['ближайший_ID_Пульса'] != target):
            raise ValueError(f'Reviewed approach {uid} has an ambiguous or displaced target')
        matches = []
        for line in lines:
            r = by_line[line]
            if (eligible(r) and r['лимит_кмч'] == card['ограничение_кмч']
                    and r['курс_град'] in card['курсы_архива_при_той_же_скорости'].split(',')
                    and math.floor(lat * 10000) == round(float(r['широта']) * 10000)
                    and math.floor(lon * 10000) == round(float(r['долгота']) * 10000)):
                matches.append(line)
        if len(matches) != 1 or matches[0] in approved:
            raise ValueError(f'Reviewed approach {uid} has no unique archive match')
        approved[matches[0]] = (uid, target)
        confirmed.add(uid)
    if confirmed != set(reviewed) or removed.intersection(approved):
        raise ValueError('Reviewed approach missing or marked as deleted')

    candidates = []
    candidate_lines = []
    if selection is not None and set(by_line) != {str(i) for i in range(1, len(rows) + 1)}:
        raise ValueError('Archive row numbers must cover the complete source')
    local = Locations()
    counts = Counter(input=len(rows))
    for r in rows:
        line = r['строка_архива']
        if line in removed:
            counts['deleted'] += 1
            continue
        if not eligible(r):
            counts['unsupported'] += 1
            continue
        lat, lon, course = float(r['широта']), float(r['долгота']), int(r['курс_град'])
        if not in_country(lat, lon):
            counts['outside'] += 1
            continue
        speed = int(r['лимит_кмч']) if r['лимит_кмч'] else None
        if speed is not None and not 5 <= speed <= 180:
            counts['invalid_speed'] += 1
            continue
        target = None
        identity = f'{lat:.4f}/{lon:.4f}/{course}'
        category = r['категория']
        if line in approved:
            identity, target = approved[line]
            if not aligns(by_id[target], course, speed):
                raise ValueError(f'Conflict with reviewed target {target}')
        elif category == 'нет_в_75м' and not any(base.near(lat, lon, 75)):
            pass
        elif category == 'одна_пара':
            neighbors = list(base.near(lat, lon, 75))
            target = r['ближайший_ID_Пульса']
            cam = by_id.get(target, {})
            flow = (cam.get('capture') or {}).get('flowDeg')
            if (len(neighbors) != 1 or neighbors[0][1] != target or neighbors[0][0] > 10
                    or speed is None or flow is None or cam.get('sourceKind') == 'dummy'
                    or not aligns(cam, course, speed) or 'speed' not in cam.get('controls', ())):
                counts['unconfirmed_match'] += 1
                continue
        else:
            counts['unconfirmed_match'] += 1
            continue
        uid = 'sco:' + hashlib.sha256(identity.encode()).hexdigest()[:20]
        record = [uid, lat, lon, course, speed, target, int(r['тип_код'])]
        if target is None:
            local.add(lat, lon, len(candidates))
        candidates.append(record)
        if selection is not None:
            candidate_lines.append(line)
    result = []
    for i, r in enumerate(candidates):
        if r[5] is None and any(j != i and course_diff(r[3], candidates[j][3]) <= 20
                                for _, j in local.near(r[1], r[2], 25)):
            counts['ambiguous_new'] += 1
            continue
        result.append(r)
        if selection is not None:
            line = candidate_lines[i]
            link = [r[5]] if r[5] is not None else None
            if line in approved:
                link.append(r[0])  # Reviewed live cards use a UUID-derived identity.
            selection[int(line)] = link
        counts['new' if r[5] is None else 'approaches'] += 1
    if len({r[0] for r in result}) != len(result):
        raise ValueError('Duplicate output identifier')
    return sorted(result, key=lambda r: r[0]), counts


def selection_table(input_rows, selected):
    mask = bytearray((input_rows + 7) // 8)
    links = {}
    for line, link in sorted(selected.items()):
        index = line - 1  # The CSV numbers source rows starting at 1.
        mask[index // 8] |= 1 << (index % 8)
        if link is not None:
            links[line] = link
    return dict(inputRows=input_rows, outputRows=len(selected),
                includeLsbFirst=base64.b64encode(mask).decode('ascii'), links=links)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('comparison', 'pulse', 'boundary', 'cards', 'reviewed', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--selection-out', type=Path,
                        help='optional public review table containing row numbers and opaque ID links')
    parser.add_argument('--version', required=True, help='data release, e.g. 2026.11.1')
    args = parser.parse_args()
    from shapely.geometry import Point, shape
    from shapely.ops import unary_union
    from shapely.prepared import prep
    areas = json.loads(args.boundary.read_text())['features']
    country = prep(unary_union([shape(f['geometry']) for f in areas]))
    reviewed = read_csv(args.reviewed)
    reviewed_by_id = {row['uuid']: row['target'] for row in reviewed}
    if len(reviewed_by_id) != len(reviewed):
        raise ValueError('Repeated reviewed UUID')
    selected = {} if args.selection_out is not None else None
    records, stats = build(read_csv(args.comparison), json.loads(args.pulse.read_text()),
                           read_csv(args.cards), reviewed_by_id,
                           lambda lat, lon: country.covers(Point(lon, lat)), selected)
    if not records:
        raise ValueError('Refusing empty result')
    data = dict(schema=1, source='speedcamonline', version=args.version,
                directionMeaning='vehicle-course', records=records)
    with tempfile.NamedTemporaryFile(mode='w', dir=args.out.parent, encoding='utf-8',
                                     delete=False) as file:
        temp = file.name
        try:
            json.dump(data, file, separators=(',', ':'), allow_nan=False)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        except BaseException:
            os.unlink(temp)
            raise
    os.replace(temp, args.out)
    if selected is not None:
        args.selection_out.write_text(json.dumps(selection_table(stats['input'], selected),
                                                 indent=2) + '\n', encoding='utf-8')
    print(json.dumps(stats, sort_keys=True))


if __name__ == '__main__':
    main()
