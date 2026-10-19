using Dapper;
using src.Data;
using src.Migrations;

namespace src.Database;

public sealed class MigrationRunner(IDbConnectionFactory connectionFactory)
{
    private static readonly IReadOnlyList<DatabaseMigration> Migrations =
    [
        CreateUsersMigration.Definition,
        AddUserEmailIndexMigration.Definition
    ];

    public async Task MigrateAsync(CancellationToken cancellationToken = default)
    {
        await using var connection = await connectionFactory.OpenConnectionAsync(cancellationToken);
        await connection.ExecuteAsync(new CommandDefinition(
            """
            create table if not exists schema_migrations (
                version integer primary key,
                applied_at_utc timestamptz not null
            );
            """,
            cancellationToken: cancellationToken));

        var appliedVersions = (await connection.QueryAsync<int>(
            new CommandDefinition(
                "select version from schema_migrations;",
                cancellationToken: cancellationToken))).ToHashSet();

        foreach (var migration in Migrations.OrderBy(item => item.Version))
        {
            if (appliedVersions.Contains(migration.Version))
            {
                continue;
            }

            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
            await connection.ExecuteAsync(new CommandDefinition(
                migration.Sql,
                transaction: transaction,
                cancellationToken: cancellationToken));
            await connection.ExecuteAsync(new CommandDefinition(
                """
                insert into schema_migrations (version, applied_at_utc)
                values (@Version, now());
                """,
                new { migration.Version },
                transaction: transaction,
                cancellationToken: cancellationToken));
            await transaction.CommitAsync(cancellationToken);
        }
    }
}
