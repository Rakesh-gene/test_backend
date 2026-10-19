using Npgsql;
using src.Data;
using src.Data.Repositories;
using src.Models;
using src.Security;
using src.Tests.TestSupport;
using Xunit;

namespace src.Tests;

public sealed class UserRepositoryTests
{
    [Fact]
    public async Task Repository_persists_and_reads_users_with_parameterized_values()
    {
        await using var database = await PostgresTestDatabase.CreateAsync();
        await new src.Database.MigrationRunner(
            new NpgsqlConnectionFactory(database.ConnectionString)).MigrateAsync();

        var repository = new UserRepository(
            new NpgsqlConnectionFactory(database.ConnectionString));
        var user = await repository.CreateAsync(new UserAccount
        {
            FirstName = "Ada",
            LastName = "Lovelace",
            Email = "ada+safe@example.com",
            PasswordHash = PasswordHasher.Hash("Password123!"),
            CreatedAtUtc = DateTime.UtcNow
        });

        var reloaded = await repository.GetByEmailAsync("ADA+SAFE@EXAMPLE.COM");
        Assert.NotNull(reloaded);
        Assert.Equal(user.Id, reloaded!.Id);
        Assert.True(PasswordHasher.Verify("Password123!", reloaded.PasswordHash));

        var (users, totalCount) = await repository.ListAsync(1, 10, "safe");
        Assert.Equal(1, totalCount);
        Assert.Single(users);
    }

    [Fact]
    public async Task Repository_and_database_enforce_case_insensitive_unique_email()
    {
        await using var database = await PostgresTestDatabase.CreateAsync();
        await new src.Database.MigrationRunner(
            new NpgsqlConnectionFactory(database.ConnectionString)).MigrateAsync();

        var repository = new UserRepository(
            new NpgsqlConnectionFactory(database.ConnectionString));
        var user = new UserAccount
        {
            FirstName = "Grace",
            LastName = "Hopper",
            Email = "grace@example.com",
            PasswordHash = PasswordHasher.Hash("Password123!"),
            CreatedAtUtc = DateTime.UtcNow
        };

        await repository.CreateAsync(user);
        Assert.True(await repository.EmailExistsAsync("GRACE@EXAMPLE.COM"));

        await Assert.ThrowsAsync<PostgresException>(() =>
            repository.CreateAsync(new UserAccount
            {
                FirstName = "Other",
                LastName = "Person",
                Email = "GRACE@EXAMPLE.COM",
                PasswordHash = PasswordHasher.Hash("Password123!"),
                CreatedAtUtc = DateTime.UtcNow
            }));
    }
}
