# #1955: resolve_redirects reuses original request

## Verified facts
- Bug reproduced with 2 local HTTP servers: POST /do_something -> 303 -> GET /new_thing_1513 -> 307 -> **POST /final** (wrong; should be GET).
- Root cause: `resolve_redirects` does `prepared_request = req.copy()` each iteration and derives `method = req.method`; `req` is never updated, so every hop rebuilds from the original POST.
- Upstream fix = commit 8d693a2a ("Fix #1955: Do not use original request in redirect"), 2-line change:
  set `req = prepared_request` before `send`, and send `req`.
- My diff is byte-identical to that commit's source hunk (requests/sessions.py only).
- Unrelated in the same upstream merge: utils.py `should_bypass_proxies` (PR #1951) and auth tests (724038e4) — NOT part of this bug, not applied.

## Commands
- repo suite: `/opt/miniconda3/envs/testbed/bin/python -m pytest test_requests.py -q` -> 119 passed, 1 failed
  (`test_conflicting_post_params`, pre-existing on baseline, unrelated).
- upstream 2.3.1 test_requests.py (has `TestRedirects::test_requests_are_updated_each_time`): 122 passed, same 1 pre-existing failure.
- /tmp/repro/repro.py: exact report chain; fails on baseline, passes with fix.
- /tmp/repro/edge.py: 307x2 (body preserved), 302->307, 303->307, 303->303->307, HEAD 303->307, 301->307, history methods.

## Notes / not in scope
- 308 is absent from `REDIRECT_STATI` in this version (pre-existing, separate issue).
