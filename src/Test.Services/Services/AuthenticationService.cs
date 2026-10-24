using src.Data.Repositories;
using Test.Shared.Models;
using src.Security;

namespace src.Services;

public sealed class AuthenticationService(IUserRepository userRepository)
{
    private static readonly string DummyPasswordHash = PasswordHasher.Hash(
        "unusable-password-for-timing-only");

    public async Task<UserAccount?> ValidateCredentialsAsync(
        string email,
        string password,
        CancellationToken cancellationToken = default)
    {
        var user = await userRepository.GetByEmailAsync(email, cancellationToken);
        var passwordHash = user?.PasswordHash ?? DummyPasswordHash;
        var passwordIsValid = false;

        try
        {
            passwordIsValid = PasswordHasher.Verify(password, passwordHash);
        }
        catch (FormatException)
        {
            passwordIsValid = false;
        }
        catch (ArgumentException)
        {
            passwordIsValid = false;
        }

        return user is not null && passwordIsValid ? user : null;
    }

    public Task<UserAccount?> GetSessionUserAsync(
        int userId,
        CancellationToken cancellationToken = default) =>
        userRepository.GetByIdAsync(userId, cancellationToken);
}
