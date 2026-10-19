using Npgsql;

namespace src.Tests.TestSupport;

internal sealed class PostgresTestDatabase : IAsyncDisposable
{
    private readonly string _adminConnectionString;
    private readonly string _schema;

    private PostgresTestDatabase(
        string adminConnectionString,
        string connectionString,
        string schema)
    {
        _adminConnectionString = adminConnectionString;
        ConnectionString = connectionString;
        _schema = schema;
    }

    public string ConnectionString { get; }

    public static async Task<PostgresTestDatabase> CreateAsync()
    {
        var adminConnectionString =
            Environment.GetEnvironmentVariable("ASDS_POSTGRES_CONNECTION_STRING") ??
            Environment.GetEnvironmentVariable("ConnectionStrings__DefaultConnection");

        if (string.IsNullOrWhiteSpace(adminConnectionString))
        {
            throw new InvalidOperationException(
                "ASDS_POSTGRES_CONNECTION_STRING or ConnectionStrings__DefaultConnection is required.");
        }

        var schema = $"test_{Guid.NewGuid():N}";
        await using var adminConnection = new NpgsqlConnection(adminConnectionString);
        await adminConnection.OpenAsync();
        await using (var createSchema = adminConnection.CreateCommand())
        {
            createSchema.CommandText = $"create schema {QuoteIdentifier(schema)};";
            await createSchema.ExecuteNonQueryAsync();
        }

        var builder = new NpgsqlConnectionStringBuilder(adminConnectionString)
        {
            SearchPath = schema
        };

        return new PostgresTestDatabase(
            adminConnectionString,
            builder.ConnectionString,
            schema);
    }

    public async ValueTask DisposeAsync()
    {
        await using var adminConnection = new NpgsqlConnection(_adminConnectionString);
        await adminConnection.OpenAsync();
        await using var dropSchema = adminConnection.CreateCommand();
        dropSchema.CommandText = $"drop schema if exists {QuoteIdentifier(_schema)} cascade;";
        await dropSchema.ExecuteNonQueryAsync();
    }

    private static string QuoteIdentifier(string identifier) => identifier;
}
