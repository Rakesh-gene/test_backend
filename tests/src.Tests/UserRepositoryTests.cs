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
