"""Writes src/planner/import/__fixtures__/plan-template.xlsx: a small synthetic copy of the
Property department's schedule template (heading row 7, a "Basis of Plan" sheet), for the import tests.
Run: python3 scripts/gen-import-fixture.py"""
import datetime, pathlib
import openpyxl

wb = openpyxl.Workbook()
ws = wb.active
ws.title = 'Schedule Template'
ws['A2'] = 'Property Development Project Schedule Template'
ws['A4'] = 'High-level stages and control gates.'
ws['A5'] = 'Dates and durations are project inputs.'
headings = ['Activity ID', 'Stage / WBS', 'Activity or milestone', 'Type', 'Lead responsibility', 'Duration (days)',
            'Baseline start', 'Baseline finish', 'Forecast finish', 'Status', 'Reference predecessors', 'Completion / release criteria']
for c, h in enumerate(headings, 1):
    ws.cell(row=7, column=c, value=h)
d = datetime.date
rows = [
    ['P010', '01 Feasibility', 'Define development brief and feasibility', 'Activity', 'Development', 40, None, None, None, 'To plan', 'Project start', 'Product mix, viability, funding strategy'],
    ['P020', '01 Feasibility', 'Approve development business case', 'Milestone', 'Investment / Client', 0, None, None, None, 'To plan', 'P010 FS', 'Investment approval to proceed'],
    ['P030', '02 Land and due diligence', 'Complete land, title and technical due diligence', 'Activity', 'Development / Legal', None, d(2027, 1, 4), d(2027, 1, 29), None, 'In progress', 'P010 SS', 'Site rights, surveys, geotechnical findings'],
    ['P035', '02 Land and due diligence', 'Survey the neighbouring plot', 'Activity', 'Development', None, None, None, None, None, 'P030 FS+5', 'Neighbouring plot survey accepted'],
    ['P040', '02 Land and due diligence', 'Secure land and development rights', 'Milestone', 'Development / Legal', 0, None, 46000, None, 'Complete', 'P020 FS; P030 FS', 'Land access and rights secured'],
    ['P420', '14 Handover', 'Complete planned handover', 'Milestone', 'Development / Customer Handover', 0, None, None, None, 'To plan', 'P040 FS; P035 FS', 'Accepted phased or full development handover'],
]
for r, row in enumerate(rows, 8):
    for c, v in enumerate(row, 1):
        if v is not None:
            ws.cell(row=r, column=c, value=v)

basis = wb.create_sheet('Basis of Plan')
basis['A2'] = 'Basis of Plan'
basis['A4'] = 'Complete the project basis, then tailor the template.'
for r, (k, v) in enumerate([
    ('Project basis / planning rule', 'Project input / reference guidance'),
    ('Project name', 'Sample villa development'),
    ('Project code / location', 'VIL-01, Plot 12'),
    ('Target construction start / handover', '2027-02-01 / 2028-06-30'),
], 6):
    basis.cell(row=r, column=1, value=k)
    basis.cell(row=r, column=2, value=v)

out = pathlib.Path(__file__).resolve().parent.parent / 'src/planner/import/__fixtures__/plan-template.xlsx'
wb.save(out)
print(out)
