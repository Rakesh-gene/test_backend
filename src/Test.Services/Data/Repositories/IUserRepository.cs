using Test.Shared.Models;

namespace src.Data.Repositories;

public interface IUserRepository
{
    Task<bool> EmailExistsAsync(string email, CancellationToken cancellationToken = default);

    Task<bool> EmailExistsForAnotherUserAsync(
        string email,
        int userId,
        CancellationToken cancellationToken = default);

    Task<UserAccount?> GetByIdAsync(int id, CancellationToken cancellationToken = default);

    Task<UserAccount?> GetByEmailAsync(string email, CancellationToken cancellationToken = default);

    Task<(IReadOnlyList<UserAccount> Users, int TotalCount)> ListAsync(
        int page,
        int pageSize,
        string? search,
        CancellationToken cancellationToken = default);

    Task<UserAccount> CreateAsync(UserAccount user, CancellationToken cancellationToken = default);

    Task<UserAccount?> UpdateAsync(
        int id,
        string firstName,
        string lastName,
        string email,
        CancellationToken cancellationToken = default);
}
