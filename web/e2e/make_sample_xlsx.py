# Makes e2e/sample.xlsx, the workbook the sheet check opens:
#   python -I e2e/make_sample_xlsx.py
# Two visible sheets and a hidden one; fills, bold, a text colour, merged
# cells, column widths, number and date formats, and a formula with no
# computed value (openpyxl writes none, as a script would).
import datetime
import os
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

wb = Workbook()
ws = wb.active
ws.title = 'Data'
ws.merge_cells('A1:C1')
ws['A1'] = 'Sample sheet'
ws['A1'].font = Font(bold=True, size=14)
ws['A1'].alignment = Alignment(horizontal='center')
for c, h in zip('ABCD', ['Item', 'Amount', 'Share', 'When']):
    cell = ws[f'{c}2']
    cell.value = h
    cell.font = Font(bold=True)
    cell.fill = PatternFill('solid', fgColor='FFD9D9D9')
rows = [
    ('apples', 1234.5, 0.125, datetime.date(2026, 11, 16)),
    ('pears', 99, 0.5, datetime.date(2026, 1, 2)),
    ('plums', 0.75, 0.375, datetime.date(2025, 12, 31)),
]
for i, (item, amount, share, when) in enumerate(rows, start=3):
    ws[f'A{i}'] = item
    ws[f'B{i}'] = amount
    ws[f'B{i}'].number_format = '#,##0.00'
    ws[f'C{i}'] = share
    ws[f'C{i}'].number_format = '0%'
    ws[f'D{i}'] = when
    ws[f'D{i}'].number_format = 'yyyy-mm-dd'
ws['A3'].fill = PatternFill('solid', fgColor='FFFFF2CC')
ws['A4'].font = Font(color='FF808080')
ws['A6'] = 'Total'
ws['A6'].font = Font(bold=True)
ws['B6'] = '=SUM(B3:B5)'
ws['B6'].number_format = '#,##0.00'
ws.column_dimensions['A'].width = 18
ws.column_dimensions['D'].width = 14

notes = wb.create_sheet('Notes')
notes['A1'] = 'A second sheet'
notes['A2'] = 'with a note'

hidden = wb.create_sheet('Hidden')
hidden['A1'] = 'not shown'
hidden.sheet_state = 'hidden'

wb.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sample.xlsx'))
