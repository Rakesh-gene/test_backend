using Microsoft.EntityFrameworkCore;
using src.Data;
using src.Models;

namespace src.Data.Repositories;

public sealed class UserRepository(AppDbContext dbContext) : IUserRepository
{
    public Task<bool> EmailExistsAsync(string email, CancellationToken cancellationToken = default) =>
        dbContext.Users.AnyAsync(user => user.Email == email, cancellationToken);

    public Task<UserAccount?> GetByIdAsync(int id, CancellationToken cancellationToken = default) =>
        dbContext.Users.AsNoTracking().SingleOrDefaultAsync(user => user.Id == id, cancellationToken);

    public async Task<UserAccount> CreateAsync(UserAccount user, CancellationToken cancellationToken = default)
    {
        dbContext.Users.Add(user);
        await dbContext.SaveChangesAsync(cancellationToken);
        return user;
    }
}
