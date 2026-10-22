# Reference generation

Environment used for the committed fixtures (also recorded in `manifest.json`):

- Python 3.12.14, NumPy 2.3.5, SciPy 1.17.0, mpmath 1.3.0 (`requirements.txt`).
- The template's fixtures were first produced with Python 3.13.5 and the same NumPy and SciPy; regenerating them here
  gave byte-identical files.

```sh
python reference/generate_fixtures.py        # writes tests/fixtures, examples, manifest.json, validation-summary.json
python reference/compare_fixtures.py OLD NEW  # compares two fixture folders (byte-identical, or numbers within 1e-12)
```

The generator's own checks (82 at present) are listed in `validation-summary.json`. They validate the references, not
the TypeScript engines: those are tested in `tests/unit` (CPU) and `tests/e2e` (WebGPU, in a browser).
