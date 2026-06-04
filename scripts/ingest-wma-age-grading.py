#!/usr/bin/env python3
"""
Ingest WMA/USATF road age-grade standards into src/data/wma-age-grading.ts.

Source files (download first):
  https://raw.githubusercontent.com/AlanLyttonJones/Age-Grade-Tables/master/2025%20Files/MaleRoadStd2025.xlsx
  https://raw.githubusercontent.com/AlanLyttonJones/Age-Grade-Tables/master/2025%20Files/FemaleRoadStd2025.xlsx

Usage:
  python3 scripts/ingest-wma-age-grading.py <MaleRoadStd2025.xlsx> <FemaleRoadStd2025.xlsx>

Reads the 'AgeStdSec' sheet (age-standard times in seconds per age x distance)
plus the 'OC sec' open-class row, for 5 km / 10 km / H. Mar / Marathon, and
prints the TypeScript table block to stdout. Paste into src/data/wma-age-grading.ts.

Tables are CC-BY-4.0 (Alan Jones / WMA / USATF MLDR). No xlsx library needed:
the sheet is parsed straight from the zip XML.
"""
import re
import sys
import zipfile

WANTED = {'5 km': 'k5', '10 km': 'k10', 'H. Mar': 'half', 'Marathon': 'marathon'}


def parse_sheet(zf: zipfile.ZipFile, sheet: str):
    xml = zf.read(f'xl/worksheets/{sheet}.xml').decode()
    strings = re.findall(r'<t[^>]*>([^<]*)</t>', zf.read('xl/sharedStrings.xml').decode())
    rows = {}
    for rm in re.finditer(r'<row r="(\d+)"[^>]*>(.*?)</row>', xml, re.S):
        cells = {}
        for cm in re.finditer(r'<c r="([A-Z]+)\d+"(?: s="\d+")?(?: t="(\w+)")?[^>]*?(?:/>|>(.*?)</c>)', rm.group(2), re.S):
            col, typ, inner = cm.group(1), cm.group(2), cm.group(3) or ''
            vm = re.search(r'<v>([^<]*)</v>', inner)
            if not vm:
                continue
            cells[col] = strings[int(vm.group(1))] if typ == 's' else vm.group(1)
        rows[int(rm.group(1))] = cells
    return rows


def find_agestd_sheet(zf: zipfile.ZipFile) -> str:
    # Male file names the sheet 'AgeStdSec'; the official female file says
    # 'AgeStanSec' (and 'Age Facctors' — quirks in the published workbook).
    wb = zf.read('xl/workbook.xml').decode()
    names = re.findall(r'<sheet [^>]*name="([^"]+)"', wb)
    for i, n in enumerate(names):
        if n in ('AgeStdSec', 'AgeStanSec'):
            return f'sheet{i + 1}'
    raise SystemExit(f'no age-standard-seconds sheet found in {names}')


def extract(path: str):
    zf = zipfile.ZipFile(path)
    rows = parse_sheet(zf, find_agestd_sheet(zf))
    title = rows[1].get('A', '')
    header = rows[2]                       # row 2: distance names
    cols = {col: WANTED[name] for col, name in header.items() if name in WANTED}
    assert len(cols) == 4, f'expected 4 wanted distances, found {cols}'
    open_row = next(r for r in rows.values() if r.get('A') == 'OC sec')
    open_sec = {key: int(float(open_row[col])) for col, key in cols.items()}
    ages = {}
    for r in sorted(rows):
        a = rows[r].get('A', '')
        if re.fullmatch(r'\d+', a or ''):
            ages[int(a)] = {key: int(float(rows[r][col])) for col, key in cols.items()}
    age_list = sorted(ages)
    assert age_list == list(range(age_list[0], age_list[-1] + 1)), 'age rows not contiguous'
    return title, open_sec, age_list[0], age_list[-1], ages


def emit(sex: str, title: str, open_sec, min_age, max_age, ages) -> str:
    lines = [f"// {title}"]
    lines.append(f"const {sex}: WmaSexTable = {{")
    lines.append(f"  minAge: {min_age}, maxAge: {max_age},")
    lines.append(f"  openSec: {{ k5: {open_sec['k5']}, k10: {open_sec['k10']}, half: {open_sec['half']}, marathon: {open_sec['marathon']} }},")
    for key in ('k5', 'k10', 'half', 'marathon'):
        vals = ', '.join(str(ages[a][key]) for a in range(min_age, max_age + 1))
        lines.append(f"  {key}: [{vals}],")
    lines.append('};')
    return '\n'.join(lines)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    for sex, path in (('MALE', sys.argv[1]), ('FEMALE', sys.argv[2])):
        title, open_sec, lo, hi, ages = extract(path)
        print(emit(sex, title, open_sec, lo, hi, ages))
        print()
