"""Regression cases for plain and month-prefixed peer-sales headers."""
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'business/monthly-python'))
from monthly_schedule import resolve_sync_cycle
from xlsx_monthly import CELL_RE, _cell_col, _cell_text, discover_layout, insert_month_column
from xml.sax.saxutils import escape


def sheet(previous=9, actual=10, peer='9月同期销量', historical=False):
    headers = [('W', f'{previous}月实发'), ('X', peer), ('Y', f'{actual}月实发'),
               ('Z', '变化情况'), ('AA', '发货前退货率'), ('AB', '发货后退货率'), ('AC', '退货率')]
    if historical:
        headers = [('U', '8月实发'), ('V', '同期销量')] + headers
    cells = ''.join(f'<c r="{col}1" t="inlineStr"><is><t>{escape(text)}</t></is></c>' for col, text in headers)
    return ('<worksheet><sheetData><row r="1">' + cells + '</row>'
            '<row r="2"><c r="W2"><v>31</v></c><c r="X2"><f>W2/30*14</f><v>14</v></c>'
            '<c r="Y2"><v>20</v></c></row></sheetData></worksheet>').encode()


def header(xml, col):
    return next(_cell_text(m, []) for m in CELL_RE.finditer(xml) if _cell_col(m) == col and m.groupdict().get('row') == b'1')


class HeaderTests(unittest.TestCase):
    def test_plain_prefixed_spaced_and_shared_headers(self):
        cycle = resolve_sync_cycle(date(2026, 10, 23))
        for text in ['同期销量', '9月同期销量', ' 9 月 同期销量\n']:
            with self.subTest(header=text):
                layout = discover_layout(sheet(peer=text, historical=True), [], cycle)
                self.assertEqual((layout.peer_col, layout.previous_col, layout.actual_col), ('X', 'W', 'Y'))
                self.assertFalse(layout.needs_insert)
        xml = sheet().replace('<c r="X1" t="inlineStr"><is><t>9月同期销量</t></is></c>'.encode(), b'<c r="X1" t="s"><v>0</v></c>')
        self.assertEqual(discover_layout(xml, ['9月同期销量'], cycle).peer_col, 'X')

    def test_rollover_advances_label_and_is_idempotent(self):
        for run, previous, actual, next_peer in [
            (date(2026, 10, 15), 8, 9, 9), (date(2026, 11, 15), 9, 10, 10),
            (date(2027, 1, 15), 11, 12, 12), (date(2026, 2, 15), 12, 1, 1),
        ]:
            with self.subTest(run=run):
                cycle = resolve_sync_cycle(run)
                rolled = insert_month_column(sheet(previous, actual, f'{previous}月同期销量'), [], cycle)
                self.assertTrue(rolled.inserted)
                self.assertEqual(header(rolled.sheet_xml, rolled.layout.peer_col), f'{next_peer}月同期销量')
                self.assertFalse(insert_month_column(rolled.sheet_xml, [], cycle).inserted)
        plain = insert_month_column(sheet(8, 9, '同期销量'), [], resolve_sync_cycle(date(2026, 10, 15)))
        self.assertEqual(header(plain.sheet_xml, plain.layout.peer_col), '同期销量')

    def test_first_node_preserves_existing_label(self):
        result = insert_month_column(sheet(), [], resolve_sync_cycle(date(2026, 11, 1)))
        self.assertFalse(result.inserted)
        self.assertEqual(header(result.sheet_xml, result.layout.peer_col), '9月同期销量')

    def test_missing_and_invalid_headers_do_not_fall_back_to_coordinates(self):
        cycle = resolve_sync_cycle(date(2026, 10, 23))
        for text in ['', '同期销售情况', '13月同期销量', '0月同期销量', '备注：9月同期销量']:
            with self.subTest(header=text), self.assertRaisesRegex(ValueError, '同期销量'):
                discover_layout(sheet(peer=text), [], cycle)
        with self.assertRaisesRegex(ValueError, 'previous-month'):
            discover_layout(sheet(previous=8), [], cycle)


if __name__ == '__main__':
    unittest.main()
