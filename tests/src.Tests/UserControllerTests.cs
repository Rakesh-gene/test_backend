using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using src.Contracts.Users;
using src.Data;
using src.Tests.TestSupport;

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

        var body = await response.Content.ReadFromJsonAsync<UserRegistrationResponse>();
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
}
