# anchor vs mini — SWE-bench Lite (10 tasks, z-ai/glm-5.3)

| task | anchor | steps | time | tokens | $ | mini | steps | time | tokens≈ | $≈ |
|---|---|---|---|---|---|---|---|---|---|---|
| psf__requests-1963 | resolved | 23 | 108s | 177,957 | $0.0206 | resolved | 39 | 501s | ≈2,820,846 | ≈$0.3279 |
| pytest-dev__pytest-11143 | resolved | 28 | 113s | 292,486 | $0.0309 | resolved | 41 | 214s | ≈3,828,068 | ≈$0.4533 |
| pallets__flask-4045 | unresolved | 38 | 185s | 508,940 | $0.0584 | unresolved | 22 | 51s | ≈323,709 | ≈$0.0485 |
| pylint-dev__pylint-5859 | resolved | 47 | 950s | 817,682 | $0.0985 | resolved | 23 | 72s | ≈401,857 | ≈$0.0585 |
| mwaskom__seaborn-2848 | unresolved | 27 | 576s | 257,551 | $0.0295 | resolved | 51 | 353s | ≈2,614,432 | ≈$0.2710 |
| sphinx-doc__sphinx-10325 | resolved | 52 | 220s | 773,988 | $0.0834 | resolved | 47 | 325s | ≈3,819,953 | ≈$0.4268 |
| django__django-10914 | resolved | 25 | 73s | 180,043 | $0.0176 | resolved | 23 | 143s | ≈461,678 | ≈$0.0627 |
| sympy__sympy-11400 | unresolved | 20 | 59s | 135,264 | $0.0146 | unresolved | 21 | 102s | ≈303,459 | ≈$0.0409 |
| matplotlib__matplotlib-18869 | resolved | 44 | 539s | 930,808 | $0.1206 | unresolved | 15 | 62s | ≈225,355 | ≈$0.0414 |
| pydata__xarray-3364 | resolved | 56 | 1315s | 1,210,218 | $0.1296 | resolved | 34 | 359s | ≈2,195,362 | ≈$0.2560 |
| **total** | **7/10** | 360 | 4137s | 5,284,937 | $0.6036 | **7/10** | 316 | 2182s | ≈16,994,719 | ≈$1.9871 |

_anchor tokens/cost: exact (provider usage, GLM 5.3 rates). mini tokens: estimate (serialized history ÷ 4); cost priced from it — mini's own accounting is disabled because litellm has no GLM 5.3 entry._
