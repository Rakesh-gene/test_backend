using src.Data.Repositories;
using src.Models;
using src.Security;
using src.Tests.TestSupport;
using Xunit;

namespace src.Tests;

public sealed class UserRepositoryTests
{
    [Fact]
    public async Task CreateAsync_persists_user_and_returns_saved_values()
    {
        await using var db = await SqliteTestDb.CreateAsync();
        var repository = new UserRepository(db.Context);

        var user = new UserAccount
        {
            FirstName = "Ada",
            LastName = "Lovelace",
            Email = "ada@example.com",
            PasswordHash = PasswordHasher.Hash("Password123!"),
            CreatedAtUtc = DateTime.UtcNow
        };

        var created = await repository.CreateAsync(user);

        Assert.True(created.Id > 0);
        Assert.True(await repository.EmailExistsAsync("ada@example.com"));

        var reloaded = await repository.GetByIdAsync(created.Id);
        Assert.NotNull(reloaded);
        Assert.Equal("Ada", reloaded!.FirstName);
        Assert.Equal("Lovelace", reloaded.LastName);
        Assert.Equal("ada@example.com", reloaded.Email);
        Assert.True(PasswordHasher.Verify("Password123!", reloaded.PasswordHash));
    }

    [Fact]
    public async Task ListAsync_returns_requested_page_with_total_count()
    {
        await using var db = await SqliteTestDb.CreateAsync();
        var repository = new UserRepository(db.Context);
        await SeedUsersAsync(db.Context,
            ("Ada", "Lovelace", "ada@example.com"),
            ("Alan", "Turing", "alan@example.com"),
            ("Grace", "Hopper", "grace@example.com"));

        var (users, totalCount) = await repository.ListAsync(page: 2, pageSize: 2, search: null);

        Assert.Equal(3, totalCount);
        var user = Assert.Single(users);
        Assert.Equal("Grace", user.FirstName);
    }

    [Fact]
    public async Task ListAsync_searches_name_and_email_fields()
    {
        await using var db = await SqliteTestDb.CreateAsync();
        var repository = new UserRepository(db.Context);
        await SeedUsersAsync(db.Context,
            ("Ada", "Lovelace", "ada@example.com"),
            ("Alan", "Turing", "alan@example.com"),
            ("Grace", "Hopper", "grace@example.com"));

        var (users, totalCount) = await repository.ListAsync(page: 1, pageSize: 10, search: "hopper");

        Assert.Equal(1, totalCount);
        var user = Assert.Single(users);
        Assert.Equal("Grace", user.FirstName);
    }

    [Fact]
    public async Task UpdateAsync_updates_allowed_fields_and_preserves_sensitive_fields()
    {
        await using var db = await SqliteTestDb.CreateAsync();
        var repository = new UserRepository(db.Context);
        await SeedUsersAsync(db.Context, ("Ada", "Lovelace", "ada@example.com"));
        var existing = db.Context.Users.Single(user => user.Email == "ada@example.com");
        var originalPasswordHash = existing.PasswordHash;
        var originalCreatedAtUtc = existing.CreatedAtUtc;

        var updated = await repository.UpdateAsync(
            existing.Id,
            firstName: "Augusta",
            lastName: "King",
            email: "augusta@example.com");

        Assert.NotNull(updated);
        Assert.Equal("Augusta", updated!.FirstName);
        Assert.Equal("King", updated.LastName);
        Assert.Equal("augusta@example.com", updated.Email);
        Assert.Equal(originalPasswordHash, updated.PasswordHash);
        Assert.Equal(originalCreatedAtUtc, updated.CreatedAtUtc);
    }

    [Fact]
    public async Task UpdateAsync_returns_null_when_user_does_not_exist()
    {
        await using var db = await SqliteTestDb.CreateAsync();
        var repository = new UserRepository(db.Context);

        var updated = await repository.UpdateAsync(
            id: 404,
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com");

        Assert.Null(updated);
    }

    [Fact]
    public async Task EmailExistsForAnotherUserAsync_excludes_current_user()
    {
        await using var db = await SqliteTestDb.CreateAsync();
        var repository = new UserRepository(db.Context);
        await SeedUsersAsync(db.Context,
            ("Ada", "Lovelace", "ada@example.com"),
            ("Alan", "Turing", "alan@example.com"));
        var ada = db.Context.Users.Single(user => user.Email == "ada@example.com");

        Assert.False(await repository.EmailExistsForAnotherUserAsync("ada@example.com", ada.Id));
        Assert.True(await repository.EmailExistsForAnotherUserAsync("alan@example.com", ada.Id));
    }

    private static async Task SeedUsersAsync(
        src.Data.AppDbContext dbContext,
        params (string FirstName, string LastName, string Email)[] users)
    {
        foreach (var user in users)
        {
            dbContext.Users.Add(new UserAccount
            {
                FirstName = user.FirstName,
                LastName = user.LastName,
                Email = user.Email,
                PasswordHash = PasswordHasher.Hash("Password123!"),
                CreatedAtUtc = DateTime.UtcNow
            });
        }

        await dbContext.SaveChangesAsync();
    }
}
