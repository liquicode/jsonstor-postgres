'use strict';

const LIB_CRYPTO = require( 'crypto' );

const jsongin = require( '@liquicode/jsongin' );
const POSTGRES = require( 'pg' );


module.exports = {

	AdapterName: 'jsonstor-postgres',
	AdapterDescription: 'Documents are stored in a PostgreSql database.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.Server ) !== 's' ) { Settings.Server = 'localhost'; }
		if ( jsongin.ShortType( Settings.Port ) !== 'n' ) { Settings.Port = 5432; }
		if ( jsongin.ShortType( Settings.Database ) !== 's' ) { throw new Error( `This adapter requires a Settings.Database string parameter.` ); }
		if ( jsongin.ShortType( Settings.Table ) !== 's' ) { throw new Error( `This adapter requires a Settings.Table string parameter.` ); }
		if ( jsongin.ShortType( Settings.UserName ) !== 's' ) { throw new Error( `This adapter requires a Settings.UserName string parameter.` ); }
		if ( jsongin.ShortType( Settings.Password ) !== 's' ) { throw new Error( `This adapter requires a Settings.Password string parameter.` ); }
		// ***Postgres has schemas and MySql does not.*** Without one, a catalog read from
		// information_schema would match a same named table in every schema on the search path
		// and answer with whichever came back first. The default is where an unqualified
		// CREATE TABLE puts a table, so a caller who ignores this setting gets the table they
		// think they asked for.
		if ( jsongin.ShortType( Settings.Schema ) !== 's' ) { Settings.Schema = 'public'; }
		if ( jsongin.ShortType( Settings.IdField ) !== 's' ) { Settings.IdField = ''; }
		if ( jsongin.ShortType( Settings.ModifySchema ) !== 'b' ) { Settings.ModifySchema = false; }
		// The storage model. See jsonx/.plans/sql-adapter-architecture.md - real columns are an
		// index which pre-filters, and the payload column carries the document. With no payload
		// column the table *is* the document, and a field with no column is refused by name.
		if ( jsongin.ShortType( Settings.PayloadColumn ) !== 's' ) { Settings.PayloadColumn = ''; }
		if ( jsongin.ShortType( Settings.PayloadSync ) !== 'b' ) { Settings.PayloadSync = false; }
		// ***Whether a field with no column of its own may be answered out of the payload.***
		//
		// Off by default, and the default is not timidity. The clause casts the payload column to
		// jsonb, and ***a value which is not JSON makes the statement throw*** - measured,
		// `invalid input syntax for type json` - so a foreign table whose payload column holds
		// ordinary text would go from working to erroring. Only a caller who knows what is in
		// that column can say.
		//
		// It also turns on the GIN index below, because the pushdown without one is a sequential
		// scan with a cast on every row, which is slower than not rendering at all.
		if ( jsongin.ShortType( Settings.PayloadPushdown ) !== 'b' ) { Settings.PayloadPushdown = false; }
		if ( jsongin.ShortType( Settings.Columns ) !== 'a' ) { Settings.Columns = []; }


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );
		Storage.Catalog = {
			initialized: false,
			fields: null,
			id_field: null,
		};


		//=====================================================================
		// The primary key column this adapter creates when it creates a table.
		//
		// ***A TEXT key rather than an integer one.*** Every other adapter in this family takes
		// the caller's _id as given and jsongin's _id is a uuid string. A foreign table's
		// identity key is still discovered and still used; this is only what gets created.
		const DEFAULT_ID_FIELD = '_id';
		const DEFAULT_ID_TYPE = 'TEXT NOT NULL';

		// ***Not JSONB, and the reason is the same one which ruled out MySQL's JSON type.***
		// JSONB stores a parsed form and hands back its own key order, so a strict equality
		// against a whole object compares a document nobody wrote. The payload has to return the
		// bytes which were written. Postgres JSON would preserve them, but it buys nothing over
		// TEXT until a dialect indexes into the payload - and that pushdown is deliberately the
		// last item of Wave 1, after all four dialects have landed.
		const PAYLOAD_TYPE = 'TEXT DEFAULT NULL';

		// The same column for a storage which asked for the payload pushdown. See ensure_schema.
		const PAYLOAD_TYPE_PUSHDOWN = `TEXT NOT NULL DEFAULT '{}'`;

		// The type a declared column gets when the caller names one without a type.
		const DEFAULT_COLUMN_TYPE = 'TEXT DEFAULT NULL';

		// ***Insertion order needs a column here, the way it does in MySQL.***
		//
		// A) CRUD Tests asserts that a collection reads back in the order it was written, and a
		// SELECT with no ORDER BY promises nothing. jsonstor-sqlite answers this with the hidden
		// rowid every table already has, and Postgres has no such thing: ctid is a physical
		// location which an UPDATE moves, so ordering by it would reorder a collection the
		// moment a document changed. An IDENTITY column is the honest answer and it is MySQL's
		// _seq under Postgres spelling.
		//
		// It is never a document field. It is excluded from every row read, every row written,
		// and from the pre-filter. A foreign table has none and is read in the server's order.
		const SEQ_FIELD = '_seq';
		const SEQ_TYPE = 'BIGINT GENERATED BY DEFAULT AS IDENTITY';


		//=====================================================================
		// ***What Postgres does differently, declared in one place.***
		//
		// SqlExpression defaults every one of these to the answer which is safe on every
		// engine, so this list is exactly what Postgres asks for beyond that. An option added
		// there later for another dialect arrives here as a default and can only cost this
		// adapter a rendering it never had - it can never narrow a clause. See
		// jsonx/.plans/sql-adapter-architecture.md, The Dialect Interface.
		//
		// ***This is jsonstor-sqlite's dialect with one flag flipped***, which is the whole
		// "options only" claim of the adapter roadmap paying out: no translator code was
		// written for this engine.
		const SQL_DIALECT = {
			// Standard SQL, and the same spellings SQLite uses: a double quote opens an
			// identifier, so a string literal is single quoted.
			IdentifierQuotes: '"',
			StringLiteralQuotes: `'`,
			// ***A backslash is an ordinary character in a standard string literal.*** Postgres
			// says so unless standard_conforming_strings is off, which it has not been by
			// default since 9.1. The quote is doubled instead, which is standard SQL.
			StringLiteralEscape: 'double',
			// Postgres has no default LIKE escape character either, so a pattern which escapes a
			// literal % has to name the character it escaped with.
			LikeEscapeCharacter: '\\',
			LikeEscapeClause: true,
			// ***The one line which differs from SQLite.*** Postgres spells the negation
			// directly, so a sub-expression is written once instead of twice:
			//     postgres   (("a" >= 0) IS NOT TRUE)
			//     sqlite     ((NOT ("a" >= 0)) OR ("a" >= 0) IS NULL)
			NegateWithIsNotTrue: true,
			// ***Left unrendered on purpose.*** Postgres can express both, and so can SQLite,
			// which declares them false for the same reason: a rendering is trusted once a live
			// server of that engine has licensed it, and per-dialect parity is deferred.
			// Dropping them broadens, which costs time and never an answer.
			RendersModulo: false,
			RendersBitwise: false,
			// ***This engine throws where the siblings coerce, and that is a fidelity question
			// rather than a performance one.*** `size = 'not-a-number'` against an integer
			// column is a wrong answer waiting to happen in MySQL and an aborted statement
			// here - and an aborted statement returns nothing for jsongin to filter, so the
			// caller gets an error instead of a broad answer. Declaring this drops the
			// predicate instead, and the row is still found by the residual.
			//
			// ***This is the option the architecture document said would be needed one day***,
			// where it noted that operand_type_agrees covers all three engines only because it
			// refuses on the type disagreement rather than on any engine's reading of it.
			RefusesTypeMismatch: true,
			// ***The one capability in this profile which no other engine here has.*** A field
			// with no column of its own can be answered out of the payload, as jsonb containment.
			// Declaring it is not enough to make it happen: SQL_Query supplies the payload column
			// only when the caller set PayloadPushdown, and the rendering needs both.
			PayloadContainment: 'jsonb',
		};


		//=====================================================================
		// ***What an integer column will actually hold.***
		//
		// This table has no counterpart in the sibling adapters and it is the one thing this
		// engine forced. See value_fits_column for why a range is a fidelity question here and
		// not a convenience.
		const INTEGER_RANGES = {
			smallint: { Low: -32768, High: 32767 },
			integer: { Low: -2147483648, High: 2147483647 },
			bigint: { Low: -9007199254740991, High: 9007199254740991 },
		};


		//=====================================================================
		// Postgres names its types in information_schema.data_type, and unlike SQLite's
		// affinity these are exact - there is no prefix matching to do and no declared type
		// text to parse.
		function short_type_of( DataType )
		{
			let type = ( jsongin.ShortType( DataType ) === 's' ) ? DataType.toLowerCase() : '';
			if ( type === 'boolean' ) { return 'b'; }
			if ( type === 'smallint' ) { return 'n'; }
			if ( type === 'integer' ) { return 'n'; }
			if ( type === 'bigint' ) { return 'n'; }
			if ( type === 'real' ) { return 'n'; }
			if ( type === 'double precision' ) { return 'n'; }
			if ( type === 'numeric' ) { return 'n'; }
			if ( type === 'text' ) { return 's'; }
			if ( type === 'character varying' ) { return 's'; }
			if ( type === 'character' ) { return 's'; }
			// Everything else - json, jsonb, bytea, timestamp, uuid, an array, a user type.
			// Deliberately outside the 'bns' set SQL_Query pre-filters on: nothing here knows
			// how this engine compares those, and a clause it cannot reason about could narrow.
			return '?';
		}


		//=====================================================================
		// Whether this column holds whole numbers only.
		//
		// ***Postgres rounds a fractional value into an integer column rather than refusing
		// it***, which is the one coercion in this engine that can cost an answer. See
		// value_fits_column.
		function is_integer_type( DataType )
		{
			let type = ( jsongin.ShortType( DataType ) === 's' ) ? DataType.toLowerCase() : '';
			return ( type === 'smallint' ) || ( type === 'integer' ) || ( type === 'bigint' );
		}


		//=====================================================================
		// An identifier, quoted the way Postgres quotes one.
		//
		// ***Quoting is not optional here.*** Postgres folds an unquoted identifier to lower
		// case, so a table created as "Test-Table" and then named unquoted is a different
		// table. Every name reaches a statement through this function, which also doubles an
		// embedded double quote - the only escape Postgres offers.
		function quote_identifier( Name )
		{
			if ( jsongin.ShortType( Name ) !== 's' ) { throw new Error( `An identifier must be a string.` ); }
			return '"' + Name.split( '"' ).join( '""' ) + '"';
		}


		//=====================================================================
		// The table, as the statements name it. Schema qualified, so a statement does not
		// depend on the connection's search path.
		function table_reference()
		{
			return quote_identifier( Storage.Settings.Schema ) + '.' + quote_identifier( Storage.Settings.Table );
		}


		//=====================================================================
		// WithClient
		//
		// ***One pool for the life of the storage, which the driver lets the process walk away
		// from.***
		//
		// This used to open a Client per statement, on the grounds that nothing would ever close
		// a held one: the Storage interface has no Close, so an open handle would sit in the
		// event loop and a finished test run would hang. ***The premise is right and the
		// conclusion is not***, because pg answers it directly - `allowExitOnIdle` unrefs a
		// pooled client the moment it goes idle, so the pool keeps its connections warm and
		// stops holding the process up. Measured: a process which leaves this pool open exits
		// in 66ms.
		//
		// ***The cost of the old pattern was a connect, an authentication and a teardown on
		// every statement.*** Against the live server, twenty statements cost 316ms opening a
		// client each time and 21ms on a held pool.
		//
		// ***A pool of its own rather than the module's global one***, so two storages pointed
		// at different servers in one process cannot share a connection - which is exactly what
		// a conformance run would do.
		//
		// ***Nothing here remembers a failure, and nothing needs to.*** A pool is not a memoized
		// connection: constructing one opens nothing, and a server which did not answer makes
		// `connect()` reject while leaving the pool willing to try again. That is the property
		// jsonstor-oracle and jsonstor-mssql have to write by hand, because they memoize a
		// promise; here the driver already has it.
		let connection_pool = null;
		async function WithClient( Handler /* ( Client ) */ )
		{
			if ( connection_pool === null )
			{
				connection_pool = new POSTGRES.Pool( {
					host: Storage.Settings.Server,
					port: Storage.Settings.Port,
					database: Storage.Settings.Database,
					user: Storage.Settings.UserName,
					password: Storage.Settings.Password,
					allowExitOnIdle: true,
				} );
				// ***A pool emits 'error' for a client which fails while sitting idle***, and an
				// unhandled 'error' on an EventEmitter takes the process down. The pool discards
				// that client either way and the next acquire opens a new one, so there is
				// nothing to do here but decline to die.
				connection_pool.on( 'error', function () { return; } );
			}
			let client = await connection_pool.connect();
			try
			{
				return await Handler( client );
			}
			finally
			{
				client.release();
			}
		}


		//=====================================================================
		// SQL_Passthrough
		//
		// The one place a statement runs. Normalized to the { results, info } shape the sibling
		// adapters answer with, so that a caller reads the same way in all three.
		// ***The dialect is checked against the server once, on the first statement.***
		//
		// The connection is lazy and `GetStorage` is synchronous, so a mismatched server cannot
		// be caught at construction and surfaces on the first operation instead. ***The outcome
		// is remembered, so every later call fails the same way***: a storage pointed at a
		// server its dialect cannot serve is wrong for its whole life, not only once.
		//
		// ***A server which did not answer is not remembered***, because that is a transient
		// failure rather than an answer, and caching it would poison the storage.
		let dialect_check = null;
		async function ensure_dialect_checked()
		{
			if ( dialect_check !== null )
			{
				if ( dialect_check.Error ) { throw dialect_check.Error; }
				return;
			}
			// Set before asking, so that StorageInfo's own statement does not re-enter this.
			dialect_check = {};
			try { await Storage.StorageInfo(); }
			catch ( error )
			{
				if ( error && error.DialectBoundary ) { dialect_check.Error = error; }
				else { dialect_check = null; }
				throw error;
			}
			return;
		}


		async function SQL_Passthrough( SqlStatement, SqlParameters = [] )
		{
			await ensure_dialect_checked();
			return await WithClient(
				async function ( Client )
				{
					let result = await Client.query( SqlStatement, SqlParameters );
					return {
						results: result.rows || [],
						info: { changes: result.rowCount || 0 },
					};
				} );
		}


		//=====================================================================
		// DDL, which takes no parameters and returns no rows.
		async function SQL_Execute( SqlStatement )
		{
			await SQL_Passthrough( SqlStatement, [] );
			return true;
		}


		//=====================================================================
		// A value on its way into a bound parameter.
		//
		// ***pg binds a boolean and a number natively***, unlike better-sqlite3 which refuses
		// both. Only undefined needs an answer, because pg sends it as NULL already but does so
		// by accident of JavaScript rather than by contract.
		function value_to_parameter( Value )
		{
			if ( typeof Value === 'undefined' ) { return null; }
			return Value;
		}


		//=====================================================================
		// The $1, $2 tokens a Postgres statement binds with.
		//
		// ***Neither sibling needs this.*** mysql2 and better-sqlite3 both take a positional ?,
		// so a statement there can be built without counting. Here a token carries its own
		// index and the count has to be right.
		function parameter_token( Index )
		{
			return '$' + Index;
		}


		//=====================================================================
		// ***The catalog is marked known only once it has been read.***
		//
		// This used to set `initialized` on the way in, which made a failed read
		// indistinguishable from an empty database: the flag stayed true, `table_exists` stayed
		// false, and every later call served that back as a fact. A Count against a server which
		// was not answering returned ***0*** rather than failing - the first call threw and every
		// one after it lied, which is the worst shape an error can take here. Setting the flag on
		// the way out is the whole fix: a read which throws leaves the catalog unknown, and the
		// next call asks again.
		//
		// ***Memoized while it is in flight***, because two concurrent first calls had a quieter
		// version of the same bug - the second saw the flag the first had just set and carried on
		// against a catalog which had not been filled in yet.
		let catalog_read = null;
		async function update_catalog()
		{
			if ( Storage.Catalog.initialized ) { return Storage.Catalog; }
			if ( catalog_read === null )
			{
				catalog_read = read_catalog().then(
					function ( Catalog )
					{
						Storage.Catalog.initialized = true;
						catalog_read = null;
						return Catalog;
					},
					function ( ReadError )
					{
						catalog_read = null;
						throw ReadError;
					} );
			}
			return await catalog_read;
		}

		async function read_catalog()
		{
			Storage.Catalog.table_exists = false;
			Storage.Catalog.fields = {};
			Storage.Catalog.id_field = Storage.Settings.IdField;
			Storage.Catalog.order_by = null;
			Storage.Catalog.payload_field = null;

			let table_rows = await SQL_Passthrough(
				`SELECT table_name FROM information_schema.tables WHERE ((table_schema = $1) AND (table_name = $2))`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			if ( !table_rows.results.length ) { return Storage.Catalog; }
			Storage.Catalog.table_exists = true;

			// The primary key columns, by name. A composite key is read but only its first
			// column is ever treated as the identity, which is the same thing the sibling
			// adapters do with one.
			let key_rows = await SQL_Passthrough(
				`SELECT kcu.column_name
					FROM information_schema.table_constraints tc
					JOIN information_schema.key_column_usage kcu
						ON ( ( kcu.constraint_name = tc.constraint_name )
							AND ( kcu.table_schema = tc.table_schema ) )
					WHERE ( ( tc.constraint_type = 'PRIMARY KEY' )
						AND ( tc.table_schema = $1 )
						AND ( tc.table_name = $2 ) )
					ORDER BY kcu.ordinal_position`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			let primary_keys = {};
			for ( let index = 0; index < key_rows.results.length; index++ )
			{
				primary_keys[ key_rows.results[ index ].column_name ] = true;
			}

			let columns = await SQL_Passthrough(
				`SELECT column_name, data_type, is_nullable, column_default, is_identity, character_maximum_length
					FROM information_schema.columns
					WHERE ( ( table_schema = $1 ) AND ( table_name = $2 ) )
					ORDER BY ordinal_position`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			for ( let index = 0; index < columns.results.length; index++ )
			{
				let column = columns.results[ index ];
				let column_default = column.column_default || '';
				let field = {
					name: column.column_name,
					type_name: column.data_type || '',
					short_type: short_type_of( column.data_type ),
					allow_null: ( column.is_nullable === 'YES' ),
					is_primary_key: !!primary_keys[ column.column_name ],
					// ***Two spellings of the same thing.*** An IDENTITY column says so
					// directly; a serial is an integer column whose default draws from a
					// sequence, and information_schema has no other word for it.
					is_identity: ( column.is_identity === 'YES' ),
					is_auto_increment: ( column.is_identity === 'YES' ) || column_default.startsWith( 'nextval(' ),
					is_integer: is_integer_type( column.data_type ),
					max_length: column.character_maximum_length,
				};
				Storage.Catalog.fields[ column.column_name ] = field;
			}

			// A configured IdField wins, then _id by name, and only then a foreign table's
			// identity key. The _seq column is never the identity - it carries insertion order
			// and this adapter creates it alongside a TEXT primary key.
			if ( !Storage.Catalog.id_field && Storage.Catalog.fields[ DEFAULT_ID_FIELD ] )
			{
				Storage.Catalog.id_field = DEFAULT_ID_FIELD;
			}
			if ( !Storage.Catalog.id_field )
			{
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === SEQ_FIELD ) { continue; }
					if ( !Storage.Catalog.fields[ key ].is_auto_increment ) { continue; }
					Storage.Catalog.id_field = key;
					break;
				}
			}
			if ( !Storage.Catalog.id_field )
			{
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === SEQ_FIELD ) { continue; }
					if ( !Storage.Catalog.fields[ key ].is_primary_key ) { continue; }
					Storage.Catalog.id_field = key;
					break;
				}
			}

			// Insertion order. See SEQ_FIELD - a table this adapter created has one, and a
			// foreign table is read in the server's order.
			if ( Storage.Catalog.fields[ SEQ_FIELD ] ) { Storage.Catalog.order_by = SEQ_FIELD; }

			// The payload column, if this storage was configured with one and the table has it.
			if ( Storage.Settings.PayloadColumn )
			{
				Storage.Catalog.payload_field =
					Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] || null;
			}

			return Storage.Catalog;
		}


		//=====================================================================
		// ensure_schema
		//
		// ***jsonstor never infers a column from a document.*** Columns come from the Columns
		// declaration when this adapter creates the table, or from the table as it was found.
		// Nothing else. See jsonx/.plans/sql-adapter-architecture.md, rule R2.
		//=====================================================================
		async function ensure_schema()
		{
			if ( !Storage.Catalog.initialized ) { await update_catalog(); }
			if ( !Storage.Settings.ModifySchema ) { return; }

			let changed = false;

			if ( !Storage.Catalog.table_exists )
			{
				// The schema first. An unqualified CREATE TABLE would land wherever the search
				// path points, and this adapter names its schema in every statement.
				await SQL_Execute( `CREATE SCHEMA IF NOT EXISTS ${quote_identifier( Storage.Settings.Schema )}` );
				let id_column = declared_id_column();
				let sql = `CREATE TABLE ${table_reference()} (`
					+ ` ${quote_identifier( id_column.Name )} ${id_column.Type} PRIMARY KEY,`
					+ ` ${quote_identifier( SEQ_FIELD )} ${SEQ_TYPE} )`;
				await SQL_Execute( sql );
				Storage.Catalog.initialized = false;
				await update_catalog();
				changed = true;
			}

			// Every declared column which is not there yet, then the payload column. Declared
			// columns carry their SQL type verbatim: this is a SQL adapter, and a caller who
			// names a table also names its types.
			let additions = [];
			for ( let index = 0; index < Storage.Settings.Columns.length; index++ )
			{
				let column = Storage.Settings.Columns[ index ];
				if ( jsongin.ShortType( column ) !== 'o' ) { continue; }
				if ( jsongin.ShortType( column.Name ) !== 's' ) { continue; }
				if ( !column.Name ) { continue; }
				if ( column.Key ) { continue; }
				if ( Storage.Catalog.fields[ column.Name ] ) { continue; }
				let type = ( jsongin.ShortType( column.Type ) === 's' ) ? column.Type : DEFAULT_COLUMN_TYPE;
				additions.push( { Name: column.Name, Type: type } );
			}
			if ( Storage.Settings.PayloadColumn && !Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] )
			{
				// ***A pushdown storage declares its payload NOT NULL, and the reason is the
				// index.*** A GIN index cannot answer IS NULL, so a nullable payload forces the
				// clause to carry an IS NULL disjunct and that disjunct takes the whole clause
				// off the index - measured on 60,000 rows. The default keeps a row which was
				// written before this column existed: '{}' is a document with no fields, which is
				// what such a row actually has in the payload.
				let payload_type = Storage.Settings.PayloadPushdown ? PAYLOAD_TYPE_PUSHDOWN : PAYLOAD_TYPE;
				additions.push( { Name: Storage.Settings.PayloadColumn, Type: payload_type } );
			}

			// Postgres takes a list of ADD COLUMN clauses in one ALTER, the way MySQL does.
			// One statement rather than a loop means the table is never half altered.
			if ( additions.length )
			{
				let clauses = [];
				for ( let index = 0; index < additions.length; index++ )
				{
					clauses.push( `ADD COLUMN ${quote_identifier( additions[ index ].Name )} ${additions[ index ].Type}` );
				}
				await SQL_Execute( `ALTER TABLE ${table_reference()} ${clauses.join( ', ' )}` );
				changed = true;
			}

			if ( changed )
			{
				Storage.Catalog.initialized = false;
				await update_catalog();
			}

			// ***The index the payload pushdown needs, and nothing else needs.***
			//
			// A GIN index over the parsed payload is what makes containment an index scan rather
			// than a scan with a cast on every row - measured on PostgreSql 10.21 and 16.15, both
			// accept the expression index and both use it. It is created only when the caller
			// asked for the pushdown, because it costs writes and storage on every document and
			// buys nothing for a storage which never queries a payload field.
			//
			// ***The expression has to match the clause exactly*** or the planner will not use
			// it, which is why both are built from the same column name and the same cast.
			if ( Storage.Settings.PayloadPushdown && Storage.Settings.PayloadColumn
				&& Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] )
			{
				let index_name = quote_identifier( Storage.Settings.Table + '_' + Storage.Settings.PayloadColumn + '_gin' );
				await SQL_Execute(
					`CREATE INDEX IF NOT EXISTS ${index_name} ON ${table_reference()}`
					+ ` USING GIN ( ( ${quote_identifier( Storage.Settings.PayloadColumn )}::jsonb ) jsonb_path_ops )` );
			}
			return;
		}


		//=====================================================================
		// The primary key column this adapter creates.
		function declared_id_column()
		{
			for ( let index = 0; index < Storage.Settings.Columns.length; index++ )
			{
				let column = Storage.Settings.Columns[ index ];
				if ( jsongin.ShortType( column ) !== 'o' ) { continue; }
				if ( !column.Key ) { continue; }
				if ( jsongin.ShortType( column.Name ) !== 's' ) { continue; }
				if ( !column.Name ) { continue; }
				let type = ( jsongin.ShortType( column.Type ) === 's' ) ? column.Type : DEFAULT_ID_TYPE;
				return { Name: column.Name, Type: type };
			}
			let name = Storage.Settings.IdField || DEFAULT_ID_FIELD;
			return { Name: name, Type: DEFAULT_ID_TYPE };
		}


		//=====================================================================
		// Whether a column can hold this value without changing it.
		//
		// ***The question is the round trip, not whether the server will accept it***, and
		// Postgres is the engine which made that distinction cost something.
		//
		// The sibling adapters ask only whether the JSON type matches the column's. That is
		// enough for them: SQLite applies affinity and stores what it cannot convert, and MySQL
		// coerces predictably. Postgres does neither. It ***rounds*** a fractional value into an
		// integer column and ***throws*** on an out of range integer or an over length varchar.
		//
		// ***Rounding is the one which costs an answer.*** Under PayloadSync a column is a
		// projection of the payload and F4 broadens every predicate on it with IS NULL, so a
		// value the column could not hold is admitted by the NULL. A rounded value is not NULL.
		// It is a wrong number sitting where a right one should be, the clause compares against
		// it, and the row never travels - which is exactly the narrowing the pre-filter
		// invariant forbids. So a fractional value does not fit an integer column, and it goes
		// to the payload with a NULL left behind to admit it.
		//
		// The range and length checks are the same argument against a thrown error rather than
		// against a wrong answer: refusing the write would fail an insert the payload could
		// have carried.
		function value_fits_column( Field, Value )
		{
			let st = jsongin.ShortType( Value );
			if ( !'bns'.includes( st ) ) { return false; }
			if ( Field.short_type !== st ) { return false; }
			if ( st === 'n' )
			{
				if ( !Number.isFinite( Value ) ) { return false; }
				if ( Field.is_integer )
				{
					if ( !Number.isInteger( Value ) ) { return false; }
					let range = INTEGER_RANGES[ Field.type_name.toLowerCase() ];
					if ( range && ( ( Value < range.Low ) || ( Value > range.High ) ) ) { return false; }
				}
			}
			if ( st === 's' )
			{
				if ( Number.isInteger( Field.max_length ) && ( Value.length > Field.max_length ) ) { return false; }
			}
			return true;
		}


		//=====================================================================
		function parse_payload( Value )
		{
			if ( ( Value === null ) || ( typeof Value === 'undefined' ) ) { return {}; }
			if ( typeof Value === 'string' )
			{
				if ( !Value ) { return {}; }
				return JSON.parse( Value );
			}
			return Value;
		}


		//=====================================================================
		function serialize_payload( Value )
		{
			return JSON.stringify( Value );
		}


		//=====================================================================
		// document_to_row
		//
		// Splits a document into the columns which pre-filter and the payload which stores it,
		// according to the three configurations in the architecture document.
		function document_to_row( Document )
		{
			let payload_name = Storage.Settings.PayloadColumn;
			let has_payload = ( Storage.Catalog.payload_field !== null );
			let row = {};

			if ( has_payload && Storage.Settings.PayloadSync )
			{
				// F3. The payload is the whole document and the columns are projections of it,
				// each holding the value when it fits and NULL when it does not. Reads never
				// take a value from a column, so a NULL here costs a pre-filter and not an
				// answer - SqlExpression broadens a projected column for exactly that reason.
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === payload_name ) { continue; }
					if ( key === SEQ_FIELD ) { continue; }
					let field = Storage.Catalog.fields[ key ];
					if ( field.is_auto_increment ) { continue; }
					if ( key === Storage.Catalog.id_field ) { continue; }
					let value = Document[ key ];
					row[ key ] = value_fits_column( field, value ) ? value : null;
				}
				row[ payload_name ] = serialize_payload( Document );
				return row;
			}

			let remainder = {};
			for ( let key in Document )
			{
				if ( key.includes( '.' ) ) { continue; }
				if ( key === payload_name )
				{
					throw new Error( `Cannot store a field named [${key}], it is this storage's payload column.` );
				}
				let value = Document[ key ];
				let field = Storage.Catalog.fields[ key ];
				if ( !field )
				{
					// F1. A field with no column is refused rather than dropped.
					if ( !has_payload )
					{
						throw new Error( `Cannot store the field [${key}], the table [${Storage.Settings.Table}] has no such column and this storage has no payload column.` );
					}
					remainder[ key ] = value;
					continue;
				}
				if ( key === SEQ_FIELD ) { continue; }
				if ( field.is_auto_increment ) { continue; }
				if ( key === Storage.Catalog.id_field ) { continue; }
				if ( jsongin.ShortType( value ) === 'l' ) { row[ key ] = null; continue; }
				if ( !value_fits_column( field, value ) )
				{
					// F2. The column is the only home this field has, so a value it cannot hold
					// is refused rather than coerced into a lie.
					throw new Error( `Cannot store the field [${key}], its value does not fit the column's type [${field.type_name}]. Configure a PayloadColumn to store values of any type.` );
				}
				row[ key ] = value;
			}
			if ( has_payload ) { row[ payload_name ] = serialize_payload( remainder ); }
			return row;
		}


		//=====================================================================
		function row_to_document( Row )
		{
			if ( !Row ) { return null; }
			let payload_name = Storage.Settings.PayloadColumn;
			let has_payload = ( Storage.Catalog.payload_field !== null );

			// F3. Under PayloadSync the payload is the document and the columns are projections
			// of it, so a value is never taken from a column. That is the whole reason this
			// configuration keeps absent apart from null and a number apart from its string:
			// the payload is real JSON and a column is not.
			if ( has_payload && Storage.Settings.PayloadSync )
			{
				return parse_payload( Row[ payload_name ] );
			}

			// The columns are the document here, so the round trip is only as good as they are.
			let document = {};
			for ( let key in Row )
			{
				if ( has_payload && ( key === payload_name ) ) { continue; }
				// Insertion order is storage bookkeeping and never a field of the document.
				if ( key === SEQ_FIELD ) { continue; }
				let value = Row[ key ];
				let field = Storage.Catalog.fields[ key ];
				// ***pg hands back bigint and numeric as strings, on purpose.*** Both can hold
				// values a JavaScript number cannot represent, so the driver refuses to lose
				// precision silently. A column declared to hold numbers has to read back as a
				// number here or the round trip reports a string where one was never stored -
				// the same repair jsonstor-sqlite makes for a boolean it had to write as 1.
				if ( field && ( field.short_type === 'n' ) && ( typeof value === 'string' ) )
				{
					value = Number( value );
				}
				document[ key ] = value;
			}
			document = jsongin.Unhybridize( document );
			if ( has_payload )
			{
				let remainder = parse_payload( Row[ payload_name ] );
				for ( let key in remainder ) { document[ key ] = remainder[ key ]; }
			}
			return document;
		}


		//=====================================================================
		// ***Options is threaded in rather than held in a closure.*** It carries the statistics
		// collector for this one call, and a variable on the Storage would blend two overlapping
		// calls into one meaningless pair of numbers.
		async function SQL_Query( Criteria, MaxDocs = 0, Options = null )
		{
			// A malformed criteria is refused, not answered - the same rule the built in
			// adapters apply. Without it a criteria of the wrong type reaches SqlExpression
			// and comes back as an empty clause, which reads as "match everything".
			let st_criteria = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( st_criteria ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }

			await update_catalog();
			if ( !Storage.Catalog.table_exists ) { return []; }

			// Convert criteria to an sql expression.
			let sql_expression_options = Object.assign( {}, SQL_DIALECT );
			sql_expression_options.AllowedFields = {};
			let payload_sync = ( Storage.Catalog.payload_field !== null ) && Storage.Settings.PayloadSync;
			for ( let key in Storage.Catalog.fields )
			{
				let field = Storage.Catalog.fields[ key ];
				if ( field.is_auto_increment ) { continue; }
				if ( key === SEQ_FIELD ) { continue; }
				if ( key === Storage.Settings.PayloadColumn ) { continue; }
				if ( !'bns'.includes( field.short_type ) ) { continue; }
				// ***The key column is left out under PayloadSync.*** It holds String( _id ), so
				// an ordering criteria on a numeric _id would compare "10" against "5" as text
				// and lose rows. The by-id paths build their own WHERE and still use the index.
				if ( payload_sync && ( key === Storage.Catalog.id_field ) ) { continue; }
				let entry = jsongin.Clone( field );
				// F4. A projected column mirrors the payload and holds NULL where the value did
				// not fit, so every predicate on it is broadened with IS NULL.
				entry.is_projection = payload_sync;
				sql_expression_options.AllowedFields[ key ] = entry;
			}
			// ***The payload is offered to the translator only on request.*** See PayloadPushdown:
			// the cast throws on a column which is not JSON, so this is the caller's call and not
			// the dialect's. Without it the translator never sees a payload column and a field
			// with no column of its own drops out exactly as it always did.
			if ( Storage.Settings.PayloadPushdown && ( Storage.Catalog.payload_field !== null ) )
			{
				sql_expression_options.PayloadContainment = 'jsonb';
				sql_expression_options.PayloadColumn = Storage.Settings.PayloadColumn;
				// Read from the catalog rather than assumed from the setting, because a table
				// this adapter did not create is the case which needs the safe clause.
				sql_expression_options.PayloadNotNull = ( Storage.Catalog.payload_field.allow_null === false );
				// ***Every column the table has, not just the ones the clause may filter on.***
				// A field left out of AllowedFields because this adapter cannot compare its type
				// still keeps its value in that column, and the payload will not have it. Asking
				// the payload about it drops the row - measured against a UUID column on a table
				// this adapter did not write.
				sql_expression_options.ColumnFields = Object.keys( Storage.Catalog.fields )
					.filter( function ( Name ) { return Name !== Storage.Settings.PayloadColumn; } );
			}

			// ***The clause narrows the search; the residual decides the answer.***
			// Today the residual is the whole criteria, so the filtering below is
			// unchanged - but reading it from the translation rather than closing over
			// Criteria is what lets a translator earn a narrower one without this
			// adapter changing again.
			let translation = jsonstor.SqlExpression.Translate( {
				Criteria: Criteria,
				Options: sql_expression_options,
			} );
			let sql_expr = translation.Pushdown;

			// Build sql statement.
			let sql = `SELECT * FROM ${table_reference()}`;
			if ( sql_expr ) { sql += ' WHERE ' + sql_expr; }
			// ***A listing is not sorted unless it says so.*** See SEQ_FIELD.
			if ( Storage.Catalog.order_by )
			{
				sql += ' ORDER BY ' + quote_identifier( Storage.Catalog.order_by );
			}

			// Get results.
			let results = await SQL_Passthrough( sql );
			let documents = results.results;

			// Do the actual query filtering here.
			let filtered = [];
			for ( let index = 0; index < documents.length; index++ )
			{
				let document = row_to_document( documents[ index ] );
				if ( jsongin.Query( document, translation.Residual ) )
				{
					filtered.push( document );
					if ( MaxDocs && ( filtered.length === MaxDocs ) ) { break; }
				}
			}

			// ***What the two stages actually did.*** A no-op unless the caller asked for it.
			// PushdownRows is what the server sent; ResidualRows is what this call produced,
			// which a MaxDocs limit stops early - FindOne reports 1 however many matched.
			jsonstor.ReportStatistics( Options, {
				Translator: Storage.SqlTranslation.TranslatorName,
				Pushdown: sql_expr || null,
				PushdownRows: documents.length,
				Residual: translation.Residual,
				ResidualRows: filtered.length,
			} );

			// Return the results.
			return filtered;
		}


		//=====================================================================
		// The value which goes in the key column.
		//
		// The payload carries the true _id with its true type; this is only what the index
		// holds. A TEXT key takes String() so that the by-id statements compare like with like.
		function id_to_key( Value )
		{
			if ( ( Value === null ) || ( typeof Value === 'undefined' ) ) { return null; }
			let field = Storage.Catalog.fields[ Storage.Catalog.id_field ];
			if ( field && 'n'.includes( field.short_type ) ) { return Value; }
			return '' + Value;
		}


		//=====================================================================
		function new_id()
		{
			// jsongin's _id is a uuid string, and the built in adapters mint one with uuid.v4()
			// when a document arrives without it. randomUUID is the same value from the runtime,
			// which keeps this adapter's dependencies to its driver.
			return LIB_CRYPTO.randomUUID();
		}


		//=====================================================================
		async function select_by_id( Key )
		{
			let sql = `SELECT * FROM ${table_reference()} WHERE (${quote_identifier( Storage.Catalog.id_field )} = ${parameter_token( 1 )})`;
			let results = await SQL_Passthrough( sql, [ value_to_parameter( Key ) ] );
			if ( !results.results.length ) { return null; }
			return row_to_document( results.results[ 0 ] );
		}


		//=====================================================================
		async function SQL_Insert( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();
			await ensure_schema();

			if ( !Storage.Catalog.table_exists ) { throw new Error( `Cannot insert rows into table [${Storage.Settings.Table}], it does not exist. Set ModifySchema to true to have it created.` ); }
			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot insert rows into table [${Storage.Settings.Table}], a primary key field was not found. ` ); }
			let id_field = Storage.Catalog.id_field;
			let id_column = Storage.Catalog.fields[ id_field ];
			let auto_increment = !!( id_column && id_column.is_auto_increment );

			// ***The caller's _id is taken as given.*** Only an auto-increment key gets to
			// choose one, and then it is the server which chooses it.
			let document = Document;
			if ( !auto_increment && ( jsongin.ShortType( document[ id_field ] ) === 'u' ) )
			{
				document = jsongin.Clone( Document );
				document[ id_field ] = new_id();
			}

			let row = document_to_row( document );
			if ( !auto_increment ) { row[ id_field ] = id_to_key( document[ id_field ] ); }

			let columns = Object.keys( row );
			if ( columns.length === 0 ) { return null; }

			let names = [];
			let tokens = [];
			let sql_parameters = [];
			for ( let index = 0; index < columns.length; index++ )
			{
				names.push( quote_identifier( columns[ index ] ) );
				tokens.push( parameter_token( index + 1 ) );
				sql_parameters.push( value_to_parameter( row[ columns[ index ] ] ) );
			}
			// ***RETURNING is how the key comes back here.*** better-sqlite3 answers a
			// lastInsertRowid and mysql2 an insertId; Postgres has neither, and asking the
			// server to hand the column back is both the portable answer and one round trip
			// rather than two.
			let sql = `INSERT INTO ${table_reference()} ( ${names.join( ', ' )} ) VALUES ( ${tokens.join( ', ' )} )`
				+ ` RETURNING ${quote_identifier( id_field )}`;

			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return null; }

			let key = auto_increment ? results.results[ 0 ][ id_field ] : row[ id_field ];
			return await select_by_id( key );
		}


		//=====================================================================
		async function SQL_Update( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();
			await ensure_schema();

			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot update rows in table [${Storage.Settings.Table}], a primary key field was not found.` ); }
			let id_field = Storage.Catalog.id_field;
			if ( jsongin.ShortType( Document[ id_field ] ) === 'u' ) { throw new Error( `Cannot update this document, it is missing the id field [${id_field}].` ); }

			let row = document_to_row( Document );
			delete row[ id_field ];
			let columns = Object.keys( row );
			if ( columns.length === 0 ) { return null; }

			let tokens = [];
			let sql_parameters = [];
			for ( let index = 0; index < columns.length; index++ )
			{
				tokens.push( `${quote_identifier( columns[ index ] )} = ${parameter_token( index + 1 )}` );
				sql_parameters.push( value_to_parameter( row[ columns[ index ] ] ) );
			}
			let key = id_to_key( Document[ id_field ] );
			let sql = `UPDATE ${table_reference()} SET ${tokens.join( ', ' )}`
				+ ` WHERE (${quote_identifier( id_field )} = ${parameter_token( columns.length + 1 )})`;
			sql_parameters.push( value_to_parameter( key ) );

			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return null; }

			return await select_by_id( key );
		}


		//=====================================================================
		async function SQL_Delete( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();

			// Get the _id field.
			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot delete rows from table [${Storage.Settings.Table}], a primary key field was not found.` ); }
			if ( jsongin.ShortType( Document[ Storage.Catalog.id_field ] ) === 'u' ) { throw new Error( `Cannot delete this document, it is missing the id field [${Storage.Catalog.id_field}].` ); }

			let sql = `DELETE FROM ${table_reference()} WHERE (${quote_identifier( Storage.Catalog.id_field )} = ${parameter_token( 1 )})`;
			let sql_parameters = [ value_to_parameter( id_to_key( Document[ Storage.Catalog.id_field ] ) ) ];

			// Get results.
			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return false; }

			return true;
		}


		//=====================================================================
		// SqlTranslation
		//
		// ***What a clause-translating adapter advertises beyond the Storage interface.***
		// This is how a shared suite, or any other caller, can ask what this adapter would
		// render and then ask the server what that rendering admits. Both halves were private
		// closures, and a suite which reconstructed them would have been measuring its own
		// copy of the dialect rather than the one this adapter actually uses.
		//
		// ***Its presence is the capability declaration.*** An adapter which does not push a
		// clause down does not define it, and a suite which needs one skips that engine
		// rather than consulting a second list somewhere which could disagree.
		//
		// Dialect answers a copy, so a caller cannot alter what this adapter renders with.
		//=====================================================================

		Storage.SqlTranslation = {
			TranslatorName: 'SqlExpression',

			// ***How this engine spells SQL, which is not the same question as how it behaves.***
			// The dialect options below say what SqlExpression renders; this says whose SQL the
			// result is, so a caller holding a statement of its own - a probe, a DDL sample -
			// can pick the spelling this server will accept. Nothing in jsonstor branches on it.
			DialectName: 'postgres',

			// The options this adapter renders with. A copy, so a caller cannot alter them.
			Dialect: function () { return Object.assign( {}, SQL_DIALECT ); },

			// ***A logical type to this engine's spelling for it.*** A shared suite declares the
			// columns it wants in jsongin's own short types and cannot know what to call them
			// here - and a column's declared type is the promise this adapter keeps by writing
			// NULL where a value does not match it, so the suite must not guess.
			ColumnTypes: {
				b: 'BOOLEAN',
				n: 'DOUBLE PRECISION',
				s: 'TEXT',
				i: 'INTEGER',
			},

			// ***How this engine spells a bound parameter.*** mysql2 and better-sqlite3 both
			// take a positional ?, so a shared suite could build a statement without asking
			// anyone; pg numbers its parameters and answers `syntax error` to a ?. A suite
			// which writes its own INSERT reads this, and one which finds no ParameterToken
			// keeps the ? it always used - so the siblings declare nothing and are unchanged.
			ParameterToken: function ( Index ) { return parameter_token( Index ); },

			// ***Normalized on purpose.*** SQL_Passthrough is not advertised directly because
			// the SQL adapters do not agree about it: mysql answers { results, fields } and
			// sqlite answers { results, info }, and sqlite needs a separate DDL path because
			// better-sqlite3's prepare() is not one. A surface whose contract differs between
			// its implementations is worse than none, so callers get rows, or a promise that
			// the statement ran.
			Query: async function ( Sql, Parameters ) { return ( await SQL_Passthrough( Sql, Parameters || [] ) ).results; },
			Execute: async function ( Sql ) { return await SQL_Execute( Sql ); },
		};

		//=====================================================================
		// DropStorage
		//=====================================================================


		// ***What this storage is actually talking to.*** Two columns rather than one, because
		// `version()` answers a whole sentence - `16.15 (Debian 16.15-1.pgdg13+2)` - which is
		// worth keeping verbatim while `server_version` is the part that can be compared.
		Storage.StorageInfo = async function ( Options )
		{
			let answer = await SQL_Passthrough(
				`SELECT current_setting('server_version') AS server_version, version() AS banner` );
			let row = answer.results[ 0 ] || {};
			// ***`server_version` is not only the version on a packaged build.*** Debian's
			// answers `14.24 (Debian 14.24-1.pgdg13+2)`, so the version is the first token and
			// the rest belongs with the banner, where the whole sentence is kept anyway.
			let reported = ( row.server_version || '' ).split( ' ' )[ 0 ];
			return jsonstor.BuildStorageInfo( Storage, {
				Product: 'PostgreSql',
				Version: reported,
				Banner: row.banner || '',
				Endpoint: `${Storage.Settings.Server}:${Storage.Settings.Port}`,
			} );
		};


		Storage.DropStorage = async function ( Options )
		{
			await SQL_Execute( `DROP TABLE IF EXISTS ${table_reference()}` );
			Storage.Catalog.initialized = false;
			await update_catalog();
			return true;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		Storage.FlushStorage = async function ( Options )
		{
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			return documents.length;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options = {} )
		{
			let document = await SQL_Insert( Document );
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options = {} )
		{
			let documents = [];
			for ( let index = 0; index < Documents.length; index++ )
			{
				documents.push( await SQL_Insert( Documents[ index ] ) );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function FindOne( Criteria, Projection, Options = {} )
		{
			// A read returns documents. ReturnDocuments gates what a *write* hands back, which
			// is how the built in adapters read: their FindOne, FindMany and FindMany2 never
			// consult it.
			let documents = await SQL_Query( Criteria, 1, Options );
			if ( !documents.length ) { return null; }
			if ( Projection )
			{
				documents[ 0 ] = jsongin.Project( documents[ 0 ], Projection );
			}
			return documents[ 0 ];
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function FindMany( Criteria, Projection, Options = {} )
		{
			// A read returns documents. See the note on FindOne.
			let documents = await SQL_Query( Criteria, 0, Options );
			if ( Projection )
			{
				for ( let index = 0; index < documents.length; index++ )
				{
					documents[ index ] = jsongin.Project( documents[ index ], Projection );
				}
			}
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function FindMany2( Criteria, Projection, Sort, MaxCount, Options = {} )
		{
			// A read returns documents. See the note on FindOne.
			let documents = await SQL_Query( Criteria, 0, Options );
			if ( Projection )
			{
				for ( let index = 0; index < documents.length; index++ )
				{
					documents[ index ] = jsongin.Project( documents[ index ], Projection );
				}
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			if ( MaxCount && ( MaxCount > 0 ) && ( documents.length > MaxCount ) ) { documents = documents.splice( 0, MaxCount ); }
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function UpdateOne( Criteria, Update, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				document = documents[ 0 ];
			}
			if ( document )
			{
				document = jsongin.Update( document, Update );
				document = await SQL_Update( document );
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function UpdateMany( Criteria, Update, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			for ( let index = 0; index < documents.length; index++ )
			{
				documents[ index ] = jsongin.Update( documents[ index ], Update );
				documents[ index ] = await SQL_Update( documents[ index ] );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ReplaceOne( Criteria, Document, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				document = documents[ 0 ];
			}
			if ( document )
			{
				if ( Document )
				{
					for ( let key in Document )
					{
						document[ key ] = Document[ key ];
					}
				}
				document = await SQL_Update( document );
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function DeleteOne( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				let result = await SQL_Delete( documents[ 0 ] );
				if ( result )
				{
					document = documents[ 0 ];
				}
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function DeleteMany( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			for ( let index = 0; index < documents.length; index++ )
			{
				await SQL_Delete( documents[ index ] );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		return Storage;
	},

};


//---------------------------------------------------------------------
// ***This package is one prime and six aliases.***
//
// PostgreSql 9.6.24, 10.21, 14.24 and 16.15 were measured against this adapter on 2026-09-01.
// ***10.21, 14.24 and 16.15 answered identically*** - the same DDL, the same catalog, and the
// same translator options - so there is one dialect profile here and no version needs a second.
//
// ***9.6 is below the floor and is a hard floor rather than a slow server.*** It refuses
// `BIGINT GENERATED BY DEFAULT AS IDENTITY` with `syntax error at or near "GENERATED"`, because
// identity columns arrive in PostgreSql 10 and the spelling before that is `serial`. This
// adapter cannot create its `_seq` column there, so it cannot create its table at all - and DDL
// either runs or it does not, with no degrading gracefully into a smaller pushdown.
//
// ***So the floor is 10.21 rather than 14.24***, which is the version that happened to be
// running when this package was written. Naming the floor after that container would have
// understated what the adapter serves by four major versions. The pair of runs which settled it
// is 9.6.24 and 10.21; see jsonx/.plans/dialect-boundaries.md.

const POSTGRES_V10 = {
	AdapterName: 'jsonstor-postgres-v10.21',
	AdapterDescription: module.exports.AdapterDescription,
	GetAdapter: module.exports.GetAdapter,
	// ***The floor this profile starts at***, and it is a real one: 9.6 cannot run this
	// adapter's DDL at all.
	Version: [ 10, 21 ],
	// ***The newest server it has actually been run against***, at the precision it was
	// measured at - the comparison zero-pads, so a short answer claims less than was run.
	MeasuredTo: [ 16, 15 ],
};

module.exports.Adapters = [ POSTGRES_V10 ];

// ***The bare name is listed here rather than left on the plugin object.*** Naming it stops
// the plugin registering itself under it, so `GetStorage( 'jsonstor-postgres' )` reports the
// prime it resolved to instead of reporting itself as its own dialect.
module.exports.Aliases = {
	'jsonstor-postgres': 'jsonstor-postgres-v10.21',
	'jsonstor-postgres-v10': 'jsonstor-postgres-v10.21',
	'jsonstor-postgres-v14': 'jsonstor-postgres-v10.21',
	'jsonstor-postgres-v14.24': 'jsonstor-postgres-v10.21',
	'jsonstor-postgres-v16': 'jsonstor-postgres-v10.21',
	'jsonstor-postgres-v16.15': 'jsonstor-postgres-v10.21',
};
