# notes

## Bug (issue #1955)
Session.resolve_redirects (requests/sessions.py) copied the ORIGINAL req each loop,
so a method rewrite from an intermediate redirect (303 POST->GET) was lost and a
later 307 re-issued POST.

## Fix (DONE, verified)
requests/sessions.py resolve_redirects: set `req = prepared_request` before self.send.
Identical in effect to upstream commit 8d693a2 ("Fix #1955: Do not use original request
in redirect"), which is the canonical fix for this report.

## Verified
- Live WSGI repro (POST/303/307): before = POST,GET,POST; after = POST,GET,GET (MATCH True).
- Upstream verbatim regression test test_requests_are_updated_each_time: fails
  ('POST'=='GET') on pristine tree, passes with fix.
- Edge cases pass: 307 chain keeps POST+body across 3 hops; 302 then 307 keeps GET;
  303 then 307 keeps GET with empty body; HEAD through 303+307 stays HEAD.
- Full test_requests.py: 119 passed, 1 failed = test_conflicting_post_params,
  which also fails on the pristine tree (modern pytest rejects string-form
  pytest.raises). Pre-existing, unrelated.
- Diff limited to requests/sessions.py; no scratch files in repo.
