# Makes e2e/sample.docx, the Word file the docx check opens:
#   python -I e2e/make_sample_docx.py
import os
import docx

d = docx.Document()
d.add_heading('Sample report', level=1)
d.add_paragraph('The opening paragraph of a short test document, with ').add_run('bold words').bold = True
t = d.add_table(rows=2, cols=2)
t.style = 'Table Grid'
for i, row in enumerate(t.rows):
    for j, c in enumerate(row.cells):
        c.text = f'cell {i}{j}'
d.add_page_break()
d.add_paragraph('Second page text.')
d.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sample.docx'))
