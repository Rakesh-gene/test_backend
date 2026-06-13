using src.Models;

namespace src.Data.Repositories;

public interface IUserRepository
{
    Task<UserAccount?> GetByIdAsync(int id, CancellationToken cancellationToken = default);

    Task<UserAccount?> GetByEmailAsync(string email, CancellationToken cancellationToken = default);

    Task<bool> EmailExistsAsync(string email, CancellationToken cancellationToken = default);

    Task<UserAccount> CreateAsync(UserAccount user, CancellationToken cancellationToken = default);
}
