using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using src.Controllers;
using src.Data.Repositories;
using src.Models;
using src.Security;
using src.Services;
using src.Contracts.Auth;
using Xunit;

namespace src.Tests;

public sealed class AuthenticationUnitTests
{
    [Fact]
    public async Task AuthenticationService_accepts_valid_credentials()
    {
        var user = CreateUser();
        var service = new AuthenticationService(new FakeUserRepository(user));

        var result = await service.ValidateCredentialsAsync(user.Email, "Password123!");

        Assert.NotNull(result);
        Assert.Equal(user.Id, result!.Id);
    }

    [Fact]
    public async Task AuthenticationService_rejects_wrong_password()
    {
        var user = CreateUser();
        var service = new AuthenticationService(new FakeUserRepository(user));

        var result = await service.ValidateCredentialsAsync(user.Email, "WrongPassword123!");

        Assert.Null(result);
    }

    [Fact]
    public async Task AuthenticationService_rejects_unknown_email_after_dummy_verification()
    {
        var service = new AuthenticationService(new FakeUserRepository(null));

        var result = await service.ValidateCredentialsAsync(
            "missing@example.com",
            "Password123!");

        Assert.Null(result);
    }

    [Fact]
    public void PasswordHasher_verifies_correct_password_and_rejects_wrong_password()
    {
        var hash = PasswordHasher.Hash("Password123!");

        Assert.True(PasswordHasher.Verify("Password123!", hash));
        Assert.False(PasswordHasher.Verify("WrongPassword123!", hash));
    }

    [Fact]
    public async Task AuthController_returns_unauthorized_for_invalid_credentials()
    {
        var service = new AuthenticationService(new FakeUserRepository(null));
        var controller = new AuthController(service)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext()
            }
        };

        var result = await controller.Login(
            new LoginRequest
            {
                Email = "missing@example.com",
                Password = "Password123!"
            },
            CancellationToken.None);

        Assert.IsType<UnauthorizedResult>(result.Result);
    }

    [Fact]
    public async Task AuthController_session_maps_user_without_password_hash()
    {
        var user = CreateUser();
        var service = new AuthenticationService(new FakeUserRepository(user));
        var httpContext = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, user.Id.ToString())
            ], "test"))
        };
        var controller = new AuthController(service)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = httpContext
            }
        };

        var result = await controller.Session(CancellationToken.None);
        var ok = Assert.IsType<OkObjectResult>(result.Result);
        var response = Assert.IsType<AuthSessionResponse>(ok.Value);

        Assert.Equal(user.Email, response.User.Email);
        Assert.DoesNotContain("PasswordHash", response.ToString(), StringComparison.Ordinal);
    }

    private static UserAccount CreateUser() =>
        new()
        {
            Id = 7,
            FirstName = "Ada",
            LastName = "Lovelace",
            Email = "ada@example.com",
            PasswordHash = PasswordHasher.Hash("Password123!"),
            CreatedAtUtc = DateTime.UtcNow
        };

    private sealed class FakeUserRepository(UserAccount? user) : IUserRepository
    {
        public Task<bool> EmailExistsAsync(
            string email,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(user is not null &&
                string.Equals(user.Email, email, StringComparison.OrdinalIgnoreCase));

        public Task<bool> EmailExistsForAnotherUserAsync(
            string email,
            int userId,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(user is not null &&
                user.Id != userId &&
                string.Equals(user.Email, email, StringComparison.OrdinalIgnoreCase));

        public Task<UserAccount?> GetByIdAsync(
            int id,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(user?.Id == id ? user : null);

        public Task<UserAccount?> GetByEmailAsync(
            string email,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(user is not null &&
                string.Equals(user.Email, email, StringComparison.OrdinalIgnoreCase)
                    ? user
                    : null);

        public Task<(IReadOnlyList<UserAccount> Users, int TotalCount)> ListAsync(
            int page,
            int pageSize,
            string? search,
            CancellationToken cancellationToken = default) =>
            Task.FromResult<(IReadOnlyList<UserAccount>, int)>(([], 0));

        public Task<UserAccount> CreateAsync(
            UserAccount newUser,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(newUser);

        public Task<UserAccount?> UpdateAsync(
            int id,
            string firstName,
            string lastName,
            string email,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(user?.Id == id ? user : null);
    }
}
