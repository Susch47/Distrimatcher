# PyInstaller-Spezifikation:  pyinstaller packaging/distrimatcher.spec
# Optional: Tesseract mitliefern -> Ordner "tesseract" (mit tesseract.exe + tessdata) neben diese Datei legen.
from pathlib import Path

root = Path(SPECPATH).parent
datas = [(str(root / "distrimatcher" / "static"), "distrimatcher/static"),
         (str(root / "distrimatcher" / "manual.md"), "distrimatcher")]
tess = Path(SPECPATH) / "tesseract"
if tess.exists():
    datas.append((str(tess), "tesseract"))

a = Analysis(
    [str(root / "packaging" / "launcher.py")],
    pathex=[str(root)],
    datas=datas,
    hiddenimports=["uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto", "uvicorn.lifespan.on",
                   "pdfminer", "pypdfium2", "openpyxl", "webview"],
    excludes=["tkinter", "matplotlib", "pandas", "numpy.tests"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Distrimatcher", console=False,
          icon=None, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="Distrimatcher", upx=False)
