# jsonstor-postgres
[`@liquicode/jsonstor-postgres`](https://github.com/liquicode/jsonstor-postgres)


# Project History


v0.2.0 (current)
---------------------------------------------------------------------

- Built on `@liquicode/jsonstor` 0.2.0 and `@liquicode/jsongin` 0.2.0. A criteria the engine
  refuses is refused before the storage acts on it.
- `FindMany2()` takes a `Paging` object, `{ SkipCount, MaxCount }`, as well as a number.
- `StorageInfo()` reports the adapter asked for, the dialect in force and the server version.
- The `PrimaryKey` setting names the identifier field. It is unique, and an update which
  changes it is refused unless `PrimaryKeyMutable` is `true`.
- Tested on PostgreSQL 10.21, 14.24 and 16.15; 10.21 is the oldest version supported.
- `PayloadPushdown` answers an equality on a field with no column of its own from the payload
  column.
- A `null` criteria matches every row, and `InsertMany` refuses a value which is not an array.
  *Was: a `null` criteria matched nothing.*
- The TLS settings are `Encrypt` and `TrustServerCertificate`.
- One connection pool is held, instead of one client per statement.
- Declares Node.js `>=16.0.0` in `engines`.


v0.1.0 (2026-08-31)
---------------------------------------------------------------------

- Initial release.
