-- Utility migration: cleans every public table except profiles and Supabase internals.
do $$
declare
	target record;
	const preserved_tables text[] := array[
		'profiles',
		'schema_migrations',
		'supabase_migrations',
		'supabase_functions_migrations'
	];
begin
	for target in
		select tablename
		from pg_tables
		where schemaname = 'public'
			and tablename <> all(preserved_tables)
	loop
		execute format('truncate table %I.%I cascade;', 'public', target.tablename);
	end loop;
end $$;
