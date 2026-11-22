import unittest
from build_speedcam_private import build


def row(line='1', course=0, speed=50, lat=50.0, category='нет_в_75м', target=''):
    return {'строка_архива': line, 'тип_код': '6', 'режим_направления': '1',
            'флаги': '0', 'курс_град': str(course), 'широта_конца': '',
            'долгота_конца': '', 'широта': str(lat), 'долгота': '40.0',
            'лимит_кмч': str(speed) if speed else '', 'категория': category,
            'ближайший_ID_Пульса': target}


def camera():
    return {'id': 'test-id', 'position': {'lat': 50., 'lon': 40.}, 'type': 'speed',
            'limitKmh': 50, 'capture': {'flowDeg': 0}, 'controls': ['speed']}


def pack(rows, pulse=(), cards=(), reviewed=None):
    return build(rows, pulse, cards, reviewed or {}, lambda lat, lon: lat >= 50)[0]


class TestPrivateOverlay(unittest.TestCase):
    def test_parallel_conflicts_and_opposing_approach(self):
        data = [row(), row('2', course=358, speed=60, lat=50.0001), row('3', course=180)]
        exported = pack(data)
        self.assertEqual(len(exported), 1)
        self.assertEqual(exported[0][3:6], [180, 50, None])
        self.assertEqual(exported, pack(data[::-1]))

    def test_real_limit_conflict_and_source_kind(self):
        point = camera()
        candidate = row(category='одна_пара', target='test-id')
        self.assertEqual(pack([candidate], [point])[0][5], 'test-id')
        for change in ({'limitKmh': 30}, {'sourceKind': 'dummy'}, {'capture': {'flowDeg': 180}},
                       {'cameraLimitConditional': '40 @ wet'}, {'controls': []}):
            self.assertEqual(pack([candidate], [{**point, **change}]), [])
        self.assertEqual(pack([candidate], [point, {**point, 'id': 'parallel'}]), [])
        self.assertEqual(pack([row()], [point]), [])

    def test_unknown_limit_exclusions_and_deletions(self):
        records = [row(speed=None), row('2', course=80), row('3', course=120),
                   row('4', lat=49), {**row('5'), 'тип_код': '7'},
                   {**row('6'), 'тип_код': '11'}, {**row('7'), 'флаги': '32'}]
        cards = [{'статус': 'удалено', 'строки_архива_в_ячейке': '2,3'}]
        output = pack(records, cards=cards)
        self.assertEqual(len(output), 1)
        self.assertIsNone(output[0][4])

    def test_distinct_reviewed_approaches(self):
        cam = {**camera(), 'capture': {}, 'limitKmh': None}
        rows = [row('1', course=30, speed=40), row('2', course=120, speed=60)]
        cards = [{'статус': 'на карте', 'UUID': r['строка_архива'],
                  'широта': r['широта'], 'долгота': r['долгота'],
                  'ближайший_ID_Пульса': 'test-id', 'ограничение_кмч': r['лимит_кмч'],
                  'строки_архива_в_ячейке': '1,2',
                  'курсы_архива_при_той_же_скорости': r['курс_град']} for r in rows]
        reviewed = {'1': 'test-id', '2': 'test-id'}
        output = pack(rows, [cam], cards, reviewed)
        self.assertEqual({tuple(x[3:6]) for x in output}, {(30, 40, 'test-id'), (120, 60, 'test-id')})
        cards[0]['статус'] = 'удалено'
        with self.assertRaises(ValueError):
            pack(rows, [cam], cards, reviewed)


if __name__ == '__main__':
    unittest.main()
