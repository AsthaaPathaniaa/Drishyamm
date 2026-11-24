"""File import (I-7): the AI only reads files inside the imports folder.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_file_import -v
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from vms_face.investigate import file_import as fi


class SafePathTest(unittest.TestCase):
    def test_only_files_inside_the_imports_root(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as other:
            ok = Path(root, "t", "i", "clip.mp4")
            ok.parent.mkdir(parents=True)
            ok.write_bytes(b"x")
            Path(other, "secret.mp4").write_bytes(b"x")
            self.assertEqual(fi.safe_path(root, str(ok)), ok.resolve())
            for bad in (str(Path(other, "secret.mp4")), f"{root}/t/i/../../../{Path(other).name}/secret.mp4",
                        str(Path(root, "missing.mp4")), root):
                with self.assertRaises(ValueError, msg=bad):
                    fi.safe_path(root, bad)

    def test_virtual_camera_code(self):
        self.assertEqual(fi.camera_code("abc"), "file:abc")


if __name__ == "__main__":
    unittest.main()
