using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using src.Data;
using src.Models;

namespace src.Data.Repositories;

public sealed class UserRepository : IUserRepository
{
    private const int SqliteConstraintErrorCode = 19;
    private const int SqliteUniqueConstraintExtendedErrorCode = 2067;
    private const int SqlitePrimaryKeyConstraintExtendedErrorCode = 1555;

    private readonly AppDbContext _dbContext;

    public UserRepository(AppDbContext dbContext)
    {
        _dbContext = dbContext;
    }

    public Task<UserAccount?> GetByIdAsync(int id, CancellationToken cancellationToken = default)
    {
        return _dbContext.Users
            .AsNoTracking()
            .SingleOrDefaultAsync(user => user.Id == id, cancellationToken);
    }

    public Task<UserAccount?> GetByEmailAsync(string email, CancellationToken cancellationToken = default)
    {
        var normalizedEmail = NormalizeEmail(email);

        return _dbContext.Users
            .AsNoTracking()
            .SingleOrDefaultAsync(user => user.Email == normalizedEmail, cancellationToken);
    }

    public Task<bool> EmailExistsAsync(string email, CancellationToken cancellationToken = default)
    {
        var normalizedEmail = NormalizeEmail(email);

        return _dbContext.Users
            .AsNoTracking()
            .AnyAsync(user => user.Email == normalizedEmail, cancellationToken);
    }

    public async Task<UserAccount> CreateAsync(UserAccount user, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(user);

        NormalizeAndValidate(user);

        if (await EmailExistsAsync(user.Email, cancellationToken).ConfigureAwait(false))
        {
            throw new DuplicateUserEmailException(user.Email);
        }

        if (user.CreatedAtUtc == default)
        {
            user.CreatedAtUtc = DateTimeOffset.UtcNow;
        }

        _dbContext.Users.Add(user);

        try
        {
            await _dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return user;
        }
        catch (DbUpdateException exception) when (IsDuplicateEmailConstraint(exception))
        {
            _dbContext.Entry(user).State = EntityState.Detached;
            throw new DuplicateUserEmailException(user.Email);
        }
    }

    private static void NormalizeAndValidate(UserAccount user)
    {
        user.FirstName = NormalizeRequired(user.FirstName, nameof(UserAccount.FirstName));
        user.LastName = NormalizeRequired(user.LastName, nameof(UserAccount.LastName));
        user.Email = NormalizeRequired(user.Email, nameof(UserAccount.Email));
    }

    private static string NormalizeRequired(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("Value cannot be null or whitespace.", parameterName);
        }

        return value.Trim();
    }

    private static string NormalizeEmail(string email)
    {
        return NormalizeRequired(email, nameof(email));
    }

    private static bool IsDuplicateEmailConstraint(DbUpdateException exception)
    {
        if (exception.InnerException is not SqliteException sqliteException)
        {
            return false;
        }

        return sqliteException.SqliteErrorCode == SqliteConstraintErrorCode
            && (sqliteException.SqliteExtendedErrorCode == SqliteUniqueConstraintExtendedErrorCode
                || sqliteException.SqliteExtendedErrorCode == SqlitePrimaryKeyConstraintExtendedErrorCode);
    }
}
