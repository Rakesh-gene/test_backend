using Microsoft.EntityFrameworkCore;
using src.Data;
using src.Models;

namespace src.Data.Repositories;

public sealed class UserRepository(AppDbContext dbContext) : IUserRepository
{
    public Task<bool> EmailExistsAsync(string email, CancellationToken cancellationToken = default) =>
        dbContext.Users.AnyAsync(user => user.Email == email, cancellationToken);

    public Task<bool> EmailExistsForAnotherUserAsync(
        string email,
        int userId,
        CancellationToken cancellationToken = default) =>
        dbContext.Users.AnyAsync(user => user.Email == email && user.Id != userId, cancellationToken);

    public Task<UserAccount?> GetByIdAsync(int id, CancellationToken cancellationToken = default) =>
        dbContext.Users.AsNoTracking().SingleOrDefaultAsync(user => user.Id == id, cancellationToken);

    public async Task<(IReadOnlyList<UserAccount> Users, int TotalCount)> ListAsync(
        int page,
        int pageSize,
        string? search,
        CancellationToken cancellationToken = default)
    {
        var query = dbContext.Users.AsNoTracking();
        var normalizedSearch = search?.Trim();

        if (!string.IsNullOrWhiteSpace(normalizedSearch))
        {
            var pattern = $"%{normalizedSearch}%";
            query = query.Where(user =>
                EF.Functions.Like(user.FirstName, pattern) ||
                EF.Functions.Like(user.LastName, pattern) ||
                EF.Functions.Like(user.Email, pattern));
        }

        var totalCount = await query.CountAsync(cancellationToken);
        var users = await query
            .OrderBy(user => user.Id)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(cancellationToken);

        return (users, totalCount);
    }

    public async Task<UserAccount> CreateAsync(UserAccount user, CancellationToken cancellationToken = default)
    {
        dbContext.Users.Add(user);
        await dbContext.SaveChangesAsync(cancellationToken);
        return user;
    }

    public async Task<UserAccount?> UpdateAsync(
        int id,
        string firstName,
        string lastName,
        string email,
        CancellationToken cancellationToken = default)
    {
        var user = await dbContext.Users.SingleOrDefaultAsync(user => user.Id == id, cancellationToken);
        if (user is null)
        {
            return null;
        }

        user.FirstName = firstName;
        user.LastName = lastName;
        user.Email = email;

        await dbContext.SaveChangesAsync(cancellationToken);
        return user;
    }
}
