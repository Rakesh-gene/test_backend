using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using src.Data;

namespace src.Tests.TestSupport;

internal sealed class SqliteTestDb : IAsyncDisposable
{
    private readonly SqliteConnection _connection;

    private SqliteTestDb(SqliteConnection connection, AppDbContext context)
    {
        _connection = connection;
        Context = context;
    }

    public AppDbContext Context { get; }

    public static async Task<SqliteTestDb> CreateAsync()
    {
        var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(connection)
            .Options;

        var context = new AppDbContext(options);
        await context.Database.EnsureCreatedAsync();

        return new SqliteTestDb(connection, context);
    }

    public async ValueTask DisposeAsync()
    {
        await Context.DisposeAsync();
        await _connection.DisposeAsync();
    }
}
