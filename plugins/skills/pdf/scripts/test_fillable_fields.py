"""Verify UTF-8 field input under a Windows locale without UTF-8 mode."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(importlib.util.find_spec('pypdf'), 'requires bundled pypdf')
class FillableFieldsTests(unittest.TestCase):
    def test_unicode_json_survives_filling_with_utf8_mode_disabled(self):
        from pypdf import PdfReader, PdfWriter
        from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, TextStringObject

        with tempfile.TemporaryDirectory(prefix='pdf-field-') as directory:
            root = Path(directory)
            source, fields, output = root / 'source.pdf', root / 'fields.json', root / 'output.pdf'
            writer = PdfWriter()
            page = writer.add_blank_page(width=300, height=200)
            font = writer._add_object(DictionaryObject({
                NameObject('/Type'): NameObject('/Font'),
                NameObject('/Subtype'): NameObject('/Type1'),
                NameObject('/BaseFont'): NameObject('/Helvetica'),
            }))
            appearance = TextStringObject('/Helv 12 Tf 0 g')
            field = writer._add_object(DictionaryObject({
                NameObject('/Type'): NameObject('/Annot'),
                NameObject('/Subtype'): NameObject('/Widget'),
                NameObject('/FT'): NameObject('/Tx'),
                NameObject('/T'): TextStringObject('employee'),
                NameObject('/Rect'): ArrayObject(map(FloatObject, [20, 100, 250, 130])),
                NameObject('/P'): page.indirect_reference,
                NameObject('/DA'): appearance,
            }))
            page[NameObject('/Annots')] = ArrayObject([field])
            writer.root_object[NameObject('/AcroForm')] = DictionaryObject({
                NameObject('/Fields'): ArrayObject([field]),
                NameObject('/DA'): appearance,
                NameObject('/DR'): DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/Helv'): font})}),
            })
            writer.write(source)
            value = '张三，研发部'
            fields.write_text(json.dumps([{'field_id': 'employee', 'page': 1, 'value': value}],
                                        ensure_ascii=False), encoding='utf-8')

            result = subprocess.run([sys.executable, '-X', 'utf8=0',
                                     str(Path(__file__).with_name('fill_fillable_fields.py')),
                                     str(source), str(fields), str(output)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))

            reader = PdfReader(output)
            self.assertEqual(reader.get_fields()['employee']['/V'], value)
            self.assertEqual(len(reader.pages), 1)


if __name__ == '__main__':
    unittest.main()
