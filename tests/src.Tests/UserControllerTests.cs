using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using src.Contracts.Common;
using src.Contracts.Users;
using src.Data;
using src.Models;
using src.Security;
using src.Tests.TestSupport;
using Xunit;

namespace src.Tests;

public sealed class UserControllerTests
{
    [Fact]
    public async Task Register_returns_created_and_persists_user()
    {
        using var factory = new RegistrationApiFactory();
        var client = factory.CreateClient();

        var request = new
        {
            firstName = "Grace",
            lastName = "Hopper",
            email = "grace@example.com",
            password = "Password123!"
        };

        var response = await client.PostAsJsonAsync("/api/user/register", request);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<UserResponse>();
        Assert.NotNull(body);
        Assert.Equal("Grace", body!.FirstName);
        Assert.Equal("grace@example.com", body.Email);

        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var storedUser = await dbContext.Users.SingleAsync(user => user.Email == "grace@example.com");

        Assert.Equal("Grace", storedUser.FirstName);
        Assert.NotEqual("Password123!", storedUser.PasswordHash);
    }

    [Fact]
    public async Task Register_returns_bad_request_for_invalid_payload()
    {
        using var factory = new RegistrationApiFactory();
        var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/user/register", new
        {
            firstName = "",
            lastName = "",
            email = "not-an-email",
            password = "short"
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Register_returns_conflict_when_email_exists()
    {
        using var factory = new RegistrationApiFactory();
        var client = factory.CreateClient();

        var request = new
        {
            firstName = "Alan",
            lastName = "Turing",
            email = "alan@example.com",
            password = "Password123!"
        };

        var firstResponse = await client.PostAsJsonAsync("/api/user/register", request);
        var secondResponse = await client.PostAsJsonAsync("/api/user/register", request);

        Assert.Equal(HttpStatusCode.Created, firstResponse.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, secondResponse.StatusCode);
    }

    [Fact]
    public async Task List_returns_users_with_pagination_metadata()
    {
        using var factory = new RegistrationApiFactory();
        await SeedUsersAsync(factory,
            ("Ada", "Lovelace", "ada@example.com"),
            ("Alan", "Turing", "alan@example.com"),
            ("Grace", "Hopper", "grace@example.com"));
        var client = factory.CreateClient();

        var response = await client.GetAsync("/api/user?page=2&pageSize=2");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<PagedResponse<UserResponse>>();

        Assert.NotNull(body);
        Assert.Equal(2, body!.Pagination.Page);
        Assert.Equal(2, body.Pagination.PageSize);
        Assert.Equal(3, body.Pagination.TotalCount);
        Assert.Equal(2, body.Pagination.TotalPages);
        var user = Assert.Single(body.Items);
        Assert.Equal("Grace", user.FirstName);
    }

    [Fact]
    public async Task List_filters_by_search()
    {
        using var factory = new RegistrationApiFactory();
        await SeedUsersAsync(factory,
            ("Ada", "Lovelace", "ada@example.com"),
            ("Alan", "Turing", "alan@example.com"),
            ("Grace", "Hopper", "grace@example.com"));
        var client = factory.CreateClient();

        var response = await client.GetAsync("/api/user?page=1&pageSize=10&search=tur");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<PagedResponse<UserResponse>>();

        Assert.NotNull(body);
        var user = Assert.Single(body!.Items);
        Assert.Equal("Alan", user.FirstName);
        Assert.Equal(1, body.Pagination.TotalCount);
    }

    [Theory]
    [InlineData(0, 10)]
    [InlineData(1, 0)]
    [InlineData(-1, 10)]
    [InlineData(1, 101)]
    public async Task List_returns_bad_request_for_invalid_paging(int page, int pageSize)
    {
        using var factory = new RegistrationApiFactory();
        var client = factory.CreateClient();

        var response = await client.GetAsync($"/api/user?page={page}&pageSize={pageSize}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Update_returns_ok_and_updates_allowed_user_fields_only()
    {
        using var factory = new RegistrationApiFactory();
        await SeedUsersAsync(factory, ("Ada", "Lovelace", "ada@example.com"));
        var client = factory.CreateClient();

        int userId;
        string originalPasswordHash;
        DateTime originalCreatedAtUtc;
        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var user = await dbContext.Users.SingleAsync(user => user.Email == "ada@example.com");
            userId = user.Id;
            originalPasswordHash = user.PasswordHash;
            originalCreatedAtUtc = user.CreatedAtUtc;
        }

        var response = await client.PutAsJsonAsync($"/api/user/{userId}", new
        {
            id = userId + 100,
            firstName = " Augusta ",
            lastName = " King ",
            email = " augusta@example.com ",
            passwordHash = "client-supplied-hash",
            createdAtUtc = DateTime.UnixEpoch
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<UserResponse>();
        Assert.NotNull(body);
        Assert.Equal(userId, body!.Id);
        Assert.Equal("Augusta", body.FirstName);
        Assert.Equal("King", body.LastName);
        Assert.Equal("augusta@example.com", body.Email);

        using var verifyScope = factory.Services.CreateScope();
        var verifyDbContext = verifyScope.ServiceProvider.GetRequiredService<AppDbContext>();
        var storedUser = await verifyDbContext.Users.SingleAsync(user => user.Id == userId);
        Assert.Equal("Augusta", storedUser.FirstName);
        Assert.Equal("King", storedUser.LastName);
        Assert.Equal("augusta@example.com", storedUser.Email);
        Assert.Equal(originalPasswordHash, storedUser.PasswordHash);
        Assert.Equal(originalCreatedAtUtc, storedUser.CreatedAtUtc);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task Update_returns_bad_request_for_invalid_id(int id)
    {
        using var factory = new RegistrationApiFactory();
        var client = factory.CreateClient();

        var response = await client.PutAsJsonAsync($"/api/user/{id}", new
        {
            firstName = "Ada",
            lastName = "Lovelace",
            email = "ada@example.com"
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Update_returns_bad_request_for_invalid_payload()
    {
        using var factory = new RegistrationApiFactory();
        var client = factory.CreateClient();

        var response = await client.PutAsJsonAsync("/api/user/1", new
        {
            firstName = "",
            lastName = "",
            email = "not-an-email"
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Update_returns_not_found_when_user_does_not_exist()
    {
        using var factory = new RegistrationApiFactory();
        await SeedUsersAsync(factory, ("Alan", "Turing", "alan@example.com"));
        var client = factory.CreateClient();

        var response = await client.PutAsJsonAsync("/api/user/404", new
        {
            firstName = "Ada",
            lastName = "Lovelace",
            email = "alan@example.com"
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Update_returns_conflict_when_email_belongs_to_another_user()
    {
        using var factory = new RegistrationApiFactory();
        await SeedUsersAsync(factory,
            ("Ada", "Lovelace", "ada@example.com"),
            ("Alan", "Turing", "alan@example.com"));
        var client = factory.CreateClient();

        int adaId;
        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            adaId = await dbContext.Users
                .Where(user => user.Email == "ada@example.com")
                .Select(user => user.Id)
                .SingleAsync();
        }

        var response = await client.PutAsJsonAsync($"/api/user/{adaId}", new
        {
            firstName = "Ada",
            lastName = "Byron",
            email = "alan@example.com"
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    private static async Task SeedUsersAsync(
        RegistrationApiFactory factory,
        params (string FirstName, string LastName, string Email)[] users)
    {
        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await dbContext.Database.EnsureCreatedAsync();

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
