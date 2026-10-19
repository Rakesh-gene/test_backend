using System.Net;
using System.Net.Http.Json;
using src.Contracts.Auth;
using src.Contracts.Users;
using src.Tests.TestSupport;
using Xunit;

namespace src.Tests;

public sealed class AuthControllerTests
{
    [Fact]
    public async Task Login_issues_secure_cookie_and_session_returns_user()
    {
        await using var database = await PostgresTestDatabase.CreateAsync();
        await using var factory = new PostgresApiFactory(database);
        using var client = factory.CreateClient(new()
        {
            BaseAddress = new Uri("https://localhost")
        });

        var registration = await client.PostAsJsonAsync("/api/user/register", new
        {
            firstName = "Grace",
            lastName = "Hopper",
            email = "grace@example.com",
            password = "Password123!"
        });
        Assert.Equal(HttpStatusCode.Created, registration.StatusCode);

        var login = await client.PostAsJsonAsync("/api/auth/login", new
        {
            email = "grace@example.com",
            password = "Password123!"
        });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.True(login.Headers.TryGetValues("Set-Cookie", out var setCookies));
        var cookie = Assert.Single(setCookies!);
        Assert.Contains("HttpOnly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Password123!", cookie, StringComparison.Ordinal);

        var body = await login.Content.ReadFromJsonAsync<AuthSessionResponse>();
        Assert.NotNull(body);
        Assert.Equal("grace@example.com", body!.User.Email);

        var session = await client.GetAsync("/api/auth/session");
        Assert.Equal(HttpStatusCode.OK, session.StatusCode);
        var sessionBody = await session.Content.ReadFromJsonAsync<AuthSessionResponse>();
        Assert.Equal(body.User.Id, sessionBody!.User.Id);
        Assert.DoesNotContain("PasswordHash", await session.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Invalid_credentials_are_unauthorized_without_account_disclosure()
    {
        await using var database = await PostgresTestDatabase.CreateAsync();
        await using var factory = new PostgresApiFactory(database);
        using var client = factory.CreateClient(new()
        {
            BaseAddress = new Uri("https://localhost")
        });

        var wrongPassword = await client.PostAsJsonAsync("/api/auth/login", new
        {
            email = "missing@example.com",
            password = "Password123!"
        });
        var unknownAccount = await client.PostAsJsonAsync("/api/auth/login", new
        {
            email = "another-missing@example.com",
            password = "Password123!"
        });

        Assert.Equal(HttpStatusCode.Unauthorized, wrongPassword.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, unknownAccount.StatusCode);

        var wrongPasswordBody = await wrongPassword.Content.ReadAsStringAsync();
        var unknownAccountBody = await unknownAccount.Content.ReadAsStringAsync();
        Assert.Contains("\"status\":401", wrongPasswordBody, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("\"status\":401", unknownAccountBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("missing@example.com", wrongPasswordBody, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("another-missing@example.com", unknownAccountBody, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Logout_expires_cookie_and_session_becomes_unauthorized()
    {
        await using var database = await PostgresTestDatabase.CreateAsync();
        await using var factory = new PostgresApiFactory(database);
        using var client = factory.CreateClient(new()
        {
            BaseAddress = new Uri("https://localhost")
        });

        await client.PostAsJsonAsync("/api/user/register", new
        {
            firstName = "Alan",
            lastName = "Turing",
            email = "alan@example.com",
            password = "Password123!"
        });
        var login = await client.PostAsJsonAsync("/api/auth/login", new
        {
            email = "alan@example.com",
            password = "Password123!"
        });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);

        var logout = await client.PostAsync("/api/auth/logout", null);
        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);

        var session = await client.GetAsync("/api/auth/session");
        Assert.Equal(HttpStatusCode.Unauthorized, session.StatusCode);
    }
}
