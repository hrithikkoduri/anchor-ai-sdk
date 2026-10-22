# Task: Set default FILE_UPLOAD_PERMISSIONS to 0o644

## Verified facts
- Base commit e7fd69d051 (Django 3.0 dev).
- django/conf/global_settings.py:307 -> FILE_UPLOAD_PERMISSIONS = None
- FileSystemStorage._save only chmods when file_permissions_mode is not None
  (django/core/files/storage.py:283), so temp-file saves keep tempfile's 0o600
  while memory saves use umask -> inconsistent.

## Planned change
- global_settings: FILE_UPLOAD_PERMISSIONS = 0o644 (+ comment tweak)
- docs/ref/settings.txt: Default: 0o644
- docs/releases/3.0.txt: backwards-incompatible note
- No test edits (hidden tests supply updated assertions).

## Tests to run
- tests/file_storage/tests.py
- tests/staticfiles_tests/test_storage.py
- tests/test_utils/tests.py
- tests/file_uploads
