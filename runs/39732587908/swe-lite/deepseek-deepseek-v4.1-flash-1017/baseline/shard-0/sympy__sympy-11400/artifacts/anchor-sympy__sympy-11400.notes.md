# ccode(sinc(x)) — DONE
- Cause: CCodePrinter had no _print_sinc -> fell to "Not supported in C" default.
- Fix: added CCodePrinter._print_sinc in sympy/printing/ccode.py, printing
  Piecewise((sin(arg)/arg, Ne(arg,0)), (1, True)).
- Verified: ccode(sinc(x)) == '((Ne(x, 0)) ? (\n   sin(x)/x\n)\n: (\n   1\n))'
  matches ccode(Piecewise(...)) byte for byte; assign_to, sinc(0)->'1', nests fine.
- Tests: test_ccode.py 30 passed; printing/tests 420 passed w/ same 5 pre-existing
  exceptions before and after (git stash compared); codegen/codeprinter/lambdarepr 89 passed.
- doctest ccode.py OK. No test files modified.
