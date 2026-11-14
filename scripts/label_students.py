#!/usr/bin/env python3
"""
Label Existing & Merged Students with (UG) or (PG)
--------------------------------------------------
Rule:
  - All Undergraduate programs -> (UG)
  - Otherwise (Graduate, Master, Diploma, PhD, etc.) -> (PG)

What this script does:
  1. Loads existing students from:
       - Student Data/StudentDetails 2.xlsx
       - Student Data/ApplicantReport S01 & S02 - 06-01-2026.xlsx
  2. Updates existing students and adds new students from:
       - Student Data/ApplicantReport 1.xlsx
       - Student Data/ApplicantReport 2.xlsx
  3. Labels every student with (UG) or (PG) based on their Program:
       - Sets the `Level` column to `(UG)` or `(PG)`
       - Prefixes the `Program` field with `(UG) ` or `(PG) `
  4. Saves:
       - Student Data/Student_Master_Merged.xlsx (all 22,328 merged & labeled students)
       - Student Data/StudentDetails_Labeled.xlsx (existing StudentDetails 2.xlsx labeled in-place)
"""

import os
import re
import openpyxl

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
STUDENT_DATA_DIR = os.path.join(BASE_DIR, 'Student Data')


def normalize_sid(val):
    if val is None:
        return ''
    s = str(val).strip()
    if re.match(r'^0+\d{4,}$', s):
        return re.sub(r'^0+', '', s)
    return s


def clean_text(val):
    if val is None:
        return None
    s = re.sub(r'\s+', ' ', re.sub(r'\*+$', '', str(val))).strip()
    if not s or s.upper() in {'N/A', 'NA', 'NONE', 'NULL', '-', '.', '0', 'NO', 'NO PASSPORT', 'لا يوجد'}:
        return None
    if s.startswith('='):
        return None
    return s


def clean_phone(val):
    txt = clean_text(val)
    if not txt:
        return None
    digits = re.sub(r'[^0-9+]', '', txt)
    if not digits or len(re.sub(r'\D', '', digits)) < 7:
        return None
    if re.match(r'^1[0125]\d{8}$', digits):
        digits = '0' + digits
    return digits


def clean_national_id(val, raw_sid, norm_sid):
    txt = clean_text(val)
    if not txt:
        return None
    if txt in (raw_sid, norm_sid) or len(txt) < 7:
        return None
    if re.match(r'^\d{8}0{6,}$', txt):
        return None
    if len(set(re.sub(r'[\s\-]', '', txt))) < 3:
        return None
    return txt


def get_program_level(program_str):
    prog = str(program_str or '').strip()
    if re.match(r'^\(UG\)\b', prog, re.I):
        return 'UG'
    if re.match(r'^\(PG\)\b', prog, re.I):
        return 'PG'
    clean_prog = re.sub(r'^\((?:UG|PG)\)\s*', '', prog, flags=re.I).strip()
    primary = clean_prog.split('/')[0].strip() if clean_prog else ''
    if re.match(r'^(graduate|postgraduate|diploma|phd|master|msc|mba|pg)\b', primary, re.I):
        return 'PG'
    if re.match(r'^(undergraduate|undergrad|bachelor|ug)\b', primary, re.I):
        return 'UG'
    return 'UG' if re.search(r'\b(undergraduate|undergrad|bachelor|ug)\b', clean_prog, re.I) else 'PG'


def ensure_program_prefix(program_str):
    raw = str(program_str or '').strip()
    clean = re.sub(r'^\((?:UG|PG)\)\s*', '', raw, flags=re.I).strip()
    level = get_program_level(clean)
    tag = f'({level})'
    return f'{tag} {clean}' if clean else tag


def pick_longer_name(a, b):
    if not a:
        return b or None
    if not b:
        return a or None
    aw = len(str(a).strip().split())
    bw = len(str(b).strip().split())
    if bw > aw:
        return b
    if aw > bw:
        return a
    return b if len(str(b)) >= len(str(a)) else a


def is_nu_email(email):
    if not email:
        return False
    s = str(email).strip()
    return '@' in s and bool(re.search(r'@([a-z0-9-]+\.)*nu\.edu([.,]eg)?$', s, re.I))


def classify_emails(*candidates):
    email = None
    personal_email = None
    for raw in candidates:
        s = clean_text(raw)
        if not s:
            continue
        if is_nu_email(s):
            if not email:
                email = s
        else:
            if not personal_email:
                personal_email = s
    return email, personal_email


def merge_emails(existing, incoming, is_sd=False):
    ex = existing or {}
    inc = incoming or {}
    nu_order = (
        [inc.get('email'), inc.get('personal_email'), ex.get('email'), ex.get('personal_email')]
        if is_sd
        else [ex.get('email'), ex.get('personal_email'), inc.get('email'), inc.get('personal_email')]
    )
    per_order = (
        [inc.get('personal_email'), inc.get('email'), ex.get('personal_email'), ex.get('email')]
        if is_sd
        else [inc.get('personal_email'), ex.get('personal_email'), inc.get('email'), ex.get('email')]
    )
    email = next((str(c).strip() for c in nu_order if c and is_nu_email(c)), None)
    personal_email = next((str(c).strip() for c in per_order if c and str(c).strip() and not is_nu_email(c)), None)
    return email, personal_email


def merge_record(existing, incoming):
    if not existing:
        email, personal_email = classify_emails(incoming.get('email'), incoming.get('personal_email'))
        rec = dict(incoming)
        rec['email'] = email
        rec['personal_email'] = personal_email
        return rec
    is_sd = incoming.get('source') == 'StudentDetails'
    email, personal_email = merge_emails(existing, incoming, is_sd=is_sd)
    return {
        'student_id': incoming.get('student_id') or existing.get('student_id'),
        'full_name': pick_longer_name(existing.get('full_name'), incoming.get('full_name')),
        'arabic_name': incoming.get('arabic_name') or existing.get('arabic_name') or None,
        'national_id': incoming.get('national_id') or existing.get('national_id') or None,
        'email': email,
        'personal_email': personal_email,
        'mobile': incoming.get('mobile') or existing.get('mobile') or None,
        'guardian_name': incoming.get('guardian_name') or existing.get('guardian_name') or None,
        'guardian_mobile': incoming.get('guardian_mobile') or existing.get('guardian_mobile') or None,
        'college': (incoming.get('college') or existing.get('college')) if is_sd else (existing.get('college') or incoming.get('college')),
        'program': (incoming.get('program') or existing.get('program')) if is_sd else (existing.get('program') or incoming.get('program')),
        'source': 'Merged' if (existing.get('source') and existing.get('source') != incoming.get('source')) else (incoming.get('source') or existing.get('source'))
    }


def parse_workbook_into_map(filepath, records_map):
    if not os.path.exists(filepath):
        print(f'  [skip] File not found: {filepath}')
        return 0
    wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
    count = 0
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            continue
        header_idx = -1
        for i in range(min(10, len(rows))):
            cells = [str(c).strip() if c is not None else '' for c in (rows[i] or [])]
            if 'Student ID' in cells or 'PEOPLE_ID1' in cells or 'People ID' in cells:
                header_idx = i
                break
        if header_idx == -1:
            continue
        headers = rows[header_idx]
        hmap = {str(h).strip(): idx for idx, h in enumerate(headers) if h is not None and str(h).strip()}
        last_raw_sid = ''
        last_sid = ''

        for row in rows[header_idx + 1:]:
            if not row:
                continue
            if 'PEOPLE_ID1' in hmap or 'People ID' in hmap:
                pid_col = 'PEOPLE_ID1' if 'PEOPLE_ID1' in hmap else 'People ID'
                cell_sid = str(row[hmap[pid_col]]).strip() if row[hmap[pid_col]] is not None else ''
                if cell_sid:
                    raw_sid = cell_sid
                    student_id = normalize_sid(raw_sid)
                    last_raw_sid = raw_sid
                    last_sid = student_id
                else:
                    raw_sid = last_raw_sid
                    student_id = last_sid
                if not student_id:
                    continue

                first = clean_text(row[hmap.get('FIRST_NAME1', hmap.get('First Name', -1))] if ('FIRST_NAME1' in hmap or 'First Name' in hmap) else None)
                middle = clean_text(row[hmap.get('MIDDLE_NAME1', hmap.get('Middle Name', -1))] if ('MIDDLE_NAME1' in hmap or 'Middle Name' in hmap) else None)
                last = clean_text(row[hmap.get('LAST_NAME1', hmap.get('Last Name', -1))] if ('LAST_NAME1' in hmap or 'Last Name' in hmap) else None)
                raw_full = clean_text(row[hmap['Full name']]) if 'Full name' in hmap else None
                combined = ' '.join([p for p in (first, middle, last) if p])
                if raw_full and last and last.lower() not in raw_full.lower():
                    full_name = f'{raw_full} {last}'.strip()
                else:
                    full_name = combined or raw_full or first or None

                arabic_name = clean_text(row[hmap['ARABICNAME']] if 'ARABICNAME' in hmap else (row[hmap['Arabic Name']] if 'Arabic Name' in hmap else None))
                gov_id = row[hmap['GOVERNMENT_ID1']] if 'GOVERNMENT_ID1' in hmap else (row[hmap['Government Id']] if 'Government Id' in hmap else None)
                pass_id = row[hmap['PASSPORT_NUMBER1']] if 'PASSPORT_NUMBER1' in hmap else (row[hmap['Passport Number']] if 'Passport Number' in hmap else None)
                national_id = clean_national_id(gov_id, raw_sid, student_id) or clean_national_id(pass_id, raw_sid, student_id)

                uni_email = row[hmap['Email1']] if 'Email1' in hmap else (row[hmap['University Email']] if 'University Email' in hmap else None)
                per_email = row[hmap['personalEmail']] if 'personalEmail' in hmap else (row[hmap['Personal Email']] if 'Personal Email' in hmap else None)
                email, personal_email = classify_emails(uni_email, per_email)

                phone_val = row[hmap['PhoneNumber1']] if 'PhoneNumber1' in hmap else (row[hmap['Phone Number']] if 'Phone Number' in hmap else None)
                mobile = clean_phone(phone_val)

                rel_val = row[hmap['Guardian_Relation']] if 'Guardian_Relation' in hmap else (row[hmap['Parent Relation']] if 'Parent Relation' in hmap else None)
                gname_val = row[hmap['Guardian_NAME']] if 'Guardian_NAME' in hmap else (row[hmap['Parent Name']] if 'Parent Name' in hmap else None)
                gmob_val = row[hmap['Guardian_Mobile']] if 'Guardian_Mobile' in hmap else (row[hmap['Parent Mobile']] if 'Parent Mobile' in hmap else None)
                rel = clean_text(rel_val)
                raw_gname = clean_text(gname_val)
                raw_gmob = clean_phone(gmob_val)

                existing_rec = records_map.get(student_id)
                is_primary_parent = bool(rel and re.match(r'^(father|mother)$', rel, re.I))
                if existing_rec and existing_rec.get('guardian_mobile') and not raw_gmob:
                    guardian_name = existing_rec.get('guardian_name')
                    guardian_mobile = existing_rec.get('guardian_mobile')
                elif existing_rec and existing_rec.get('guardian_name') and not is_primary_parent and existing_rec.get('_is_primary_parent'):
                    guardian_name = existing_rec.get('guardian_name')
                    guardian_mobile = existing_rec.get('guardian_mobile') or raw_gmob
                else:
                    guardian_name = raw_gname
                    guardian_mobile = raw_gmob

                uni_val = row[hmap['University1']] if 'University1' in hmap else (row[hmap['University']] if 'University' in hmap else None)
                curr_val = row[hmap['CURRICULUM1']] if 'CURRICULUM1' in hmap else (row[hmap['Curriculum']] if 'Curriculum' in hmap else None)
                college = clean_text(uni_val) or clean_text(curr_val)

                prog_val = row[hmap['PROGRAM1']] if 'PROGRAM1' in hmap else (row[hmap['Program']] if 'Program' in hmap else None)
                deg_val = row[hmap['DEGREE1']] if 'DEGREE1' in hmap else (row[hmap['Degree']] if 'Degree' in hmap else None)
                prog_parts = []
                for p in (clean_text(prog_val), clean_text(deg_val), clean_text(curr_val)):
                    if p and p not in prog_parts:
                        prog_parts.append(p)
                program = ' / '.join(prog_parts) if prog_parts else None

                incoming = {
                    'student_id': student_id,
                    'full_name': full_name,
                    'arabic_name': arabic_name,
                    'national_id': national_id,
                    'email': email,
                    'personal_email': personal_email,
                    'mobile': mobile,
                    'guardian_name': guardian_name,
                    'guardian_mobile': guardian_mobile,
                    'college': college,
                    'program': program,
                    'source': 'ApplicantReport'
                }
                merged = merge_record(existing_rec, incoming)
                if is_primary_parent and (raw_gname or raw_gmob):
                    merged['_is_primary_parent'] = True
                elif existing_rec and existing_rec.get('_is_primary_parent'):
                    merged['_is_primary_parent'] = True
                records_map[student_id] = merged
                count += 1
            elif 'Student ID' in hmap:
                raw_sid = str(row[hmap['Student ID']] or '').strip()
                student_id = normalize_sid(raw_sid)
                if not student_id:
                    continue
                full_name = clean_text(row[hmap.get('Student Name', hmap.get('Full Name', -1))])
                arabic_name = clean_text(row[hmap['Arabic Name']]) if 'Arabic Name' in hmap else None
                national_id = clean_national_id(row[hmap['National ID']] if 'National ID' in hmap else None, raw_sid, student_id)
                raw_email = row[hmap['Email']] if 'Email' in hmap else (row[hmap['NU Email']] if 'NU Email' in hmap else None)
                raw_per_email = row[hmap['Personal Email']] if 'Personal Email' in hmap else (row[hmap['Secondary Email']] if 'Secondary Email' in hmap else None)
                email, personal_email = classify_emails(raw_email, raw_per_email)
                mob1 = clean_phone(row[hmap['Mobile Phone Number']]) if 'Mobile Phone Number' in hmap else (clean_phone(row[hmap['Mobile']]) if 'Mobile' in hmap else None)
                mob2 = clean_phone(row[hmap['Home Phone Number']]) if 'Home Phone Number' in hmap else None
                mobile = mob1 or mob2
                guardian_name = clean_text(row[hmap['Guardian Name']]) if 'Guardian Name' in hmap else None
                guardian_mobile = clean_phone(row[hmap['Guardian Mobile']]) if 'Guardian Mobile' in hmap else None
                college = clean_text(row[hmap['College']] if 'College' in hmap else None)
                program = clean_text(row[hmap['Program']] if 'Program' in hmap else None)
                source = clean_text(row[hmap['Source']]) if 'Source' in hmap else 'StudentDetails'

                incoming = {
                    'student_id': student_id,
                    'full_name': full_name,
                    'arabic_name': arabic_name,
                    'national_id': national_id,
                    'email': email,
                    'personal_email': personal_email,
                    'mobile': mobile,
                    'guardian_name': guardian_name,
                    'guardian_mobile': guardian_mobile,
                    'college': college,
                    'program': program,
                    'source': source
                }
                records_map[student_id] = merge_record(records_map.get(student_id), incoming)
                count += 1
    wb.close()
    return count


def main():
    print('=' * 72)
    print('🏷️  STUDENT (UG) / (PG) LABELING & MASTER MERGE SCRIPT')
    print('=' * 72)

    files_in_order = [
        os.path.join(STUDENT_DATA_DIR, 'StudentDetails 2.xlsx'),
        os.path.join(STUDENT_DATA_DIR, 'ApplicantReport S01 & S02 - 06-01-2026.xlsx'),
        os.path.join(STUDENT_DATA_DIR, 'ApplicantReport 1.xlsx'),
        os.path.join(STUDENT_DATA_DIR, 'ApplicantReport 2.xlsx'),
    ]

    records_map = {}
    for fp in files_in_order:
        rows_read = parse_workbook_into_map(fp, records_map)
        print(f'  ✓ Processed {os.path.basename(fp)}: {rows_read:,} rows (Unique students so far: {len(records_map):,})')

    ug_count = 0
    pg_count = 0
    sorted_students = sorted(records_map.values(), key=lambda r: r['student_id'])

    out_wb = openpyxl.Workbook()
    out_ws = out_wb.active
    out_ws.title = 'Students'
    headers = [
        'Student ID', 'Level', 'Full Name', 'Arabic Name', 'Email', 'Personal Email',
        'Mobile', 'National ID', 'College', 'Program',
        'Guardian Name', 'Guardian Mobile', 'Source'
    ]
    out_ws.append(headers)

    for s in sorted_students:
        lvl = get_program_level(s.get('program'))
        tag = f'({lvl})'
        labeled_program = ensure_program_prefix(s.get('program'))
        if lvl == 'UG':
            ug_count += 1
        else:
            pg_count += 1

        out_ws.append([
            s.get('student_id') or '',
            tag,
            s.get('full_name') or '',
            s.get('arabic_name') or '',
            s.get('email') or '',
            s.get('personal_email') or '',
            s.get('mobile') or '',
            s.get('national_id') or '',
            s.get('college') or '',
            labeled_program,
            s.get('guardian_name') or '',
            s.get('guardian_mobile') or '',
            s.get('source') or ''
        ])

    merged_out_path = os.path.join(STUDENT_DATA_DIR, 'Student_Master_Merged.xlsx')
    out_wb.save(merged_out_path)

    print('-' * 72)
    print(f'✅ Labeled Total Students : {len(sorted_students):,}')
    print(f'   • Undergraduate (UG)   : {ug_count:,}')
    print(f'   • Postgraduate  (PG)   : {pg_count:,}')
    print(f'   • Saved Merged File    : {merged_out_path}')
    print('=' * 72)


if __name__ == '__main__':
    main()
