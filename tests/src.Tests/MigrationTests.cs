using Npgsql;
using src.Data;
using src.Database;
using src.Tests.TestSupport;
using Xunit;

namespace src.Tests;

public sealed class MigrationTests
{
    [Fact]
    public async Task Migrations_create_schema_in_order_and_are_idempotent()
    {
        await using var database = await PostgresTestDatabase.CreateAsync();
        var runner = new MigrationRunner(new NpgsqlConnectionFactory(database.ConnectionString));

        await runner.MigrateAsync();
        await runner.MigrateAsync();

        await using var connection = new NpgsqlConnection(database.ConnectionString);
        await connection.OpenAsync();

        Assert.Equal(2, await ScalarAsync<long>(
            connection,
            "select count(*) from schema_migrations;"));
        Assert.Equal(2, await ScalarAsync<long>(
            connection,
            "select count(*) from schema_migrations where version in (1, 2);"));
        Assert.Equal(1, await ScalarAsync<long>(
            connection,
            """
            select count(*) from information_schema.tables
            where table_schema = current_schema() and table_name = 'users';
            """));
        Assert.Equal(1, await ScalarAsync<long>(
            connection,
            """
            select count(*) from pg_indexes
            where schemaname = current_schema()
              and indexname = 'ux_users_email_lower';
            """));
    }

    private static async Task<T> ScalarAsync<T>(
        NpgsqlConnection connection,
        string sql)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        return (T)(await command.ExecuteScalarAsync())!;
    }
}
