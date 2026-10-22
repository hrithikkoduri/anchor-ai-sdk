# Redirect method regression notes

## Verified facts
- Root cause: `resolve_redirects` re-copied the original prepared request (`req`) each redirect loop; method source was `req.method`.
- Before fix repro output:
  - `final_method_seen_by_server2= POST`
  - `history_statuses= [303, 307]`
  - `history_methods= ['POST', 'GET']`
  - `final_request_method= POST`
- Code fix in `requests/sessions.py` now clones the most recent request with `prepared_request = resp.request.copy()` and seeds method from `prepared_request.method`.
- Added regression test: `RequestsTestCase.test_303_then_307_redirect_keeps_changed_method`.
- After fix repro output:
  - `final_method_seen_by_server2= GET`
  - `history_statuses= [303, 307]`
  - `history_methods= ['POST', 'GET']`
  - `final_request_method= GET`

## Validation run
- `pytest test_requests.py -k "303_then_307_redirect_keeps_changed_method or HTTP_302_ALLOW_REDIRECT_GET or cookie_sent_on_redirect or requests_in_history_are_not_overridden or uppercase_scheme_redirect"` -> 5 passed.
- `pytest test_requests.py` -> 1 unrelated baseline failure (`test_conflicting_post_params` TypeError from pytest string-style raises).

## Open questions
- Full suite remains blocked by pre-existing test compatibility issue in `test_conflicting_post_params`; change under test validated by targeted passing checks and explicit repro.
