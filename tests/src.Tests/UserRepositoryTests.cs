using src.Data.Repositories;
using src.Models;
using src.Security;
using src.Tests.TestSupport;

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
}
