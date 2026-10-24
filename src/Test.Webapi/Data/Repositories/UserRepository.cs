using Dapper;
using Test.Shared.Models;

namespace src.Data.Repositories;

public sealed class UserRepository(IDbConnectionFactory connectionFactory) : IUserRepository
{
    public async Task<bool> EmailExistsAsync(
        string email,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await connectionFactory.OpenConnectionAsync(cancellationToken);
        return await connection.ExecuteScalarAsync<bool>(
            new CommandDefinition(
                "select exists (select 1 from users where lower(email) = lower(@Email));",
                new { Email = email },
                cancellationToken: cancellationToken));
    }

    public async Task<bool> EmailExistsForAnotherUserAsync(
        string email,
        int userId,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await connectionFactory.OpenConnectionAsync(cancellationToken);
        return await connection.ExecuteScalarAsync<bool>(
            new CommandDefinition(
                """
                select exists (
                    select 1 from users
                    where lower(email) = lower(@Email) and id <> @UserId
                );
                """,
                new { Email = email, UserId = userId },
                cancellationToken: cancellationToken));
    }

    public async Task<UserAccount?> GetByIdAsync(
        int id,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await connectionFactory.OpenConnectionAsync(cancellationToken);
        return await connection.QuerySingleOrDefaultAsync<UserAccount>(
            new CommandDefinition(
                """
                select id, first_name as FirstName, last_name as LastName,
                       email, password_hash as PasswordHash,
                       created_at_utc as CreatedAtUtc
                from users where id = @Id;
                """,
                new { Id = id },
                cancellationToken: cancellationToken));
    }

    public async Task<UserAccount?> GetByEmailAsync(
        string email,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await connectionFactory.OpenConnectionAsync(cancellationToken);
        return await connection.QuerySingleOrDefaultAsync<UserAccount>(
            new CommandDefinition(
                """
                select id, first_name as FirstName, last_name as LastName,
                       email, password_hash as PasswordHash,
                       created_at_utc as CreatedAtUtc
                from users
                where lower(email) = lower(@Email);
                """,
                new { Email = email },
                cancellationToken: cancellationToken));
    }

    public async Task<(IReadOnlyList<UserAccount> Users, int TotalCount)> ListAsync(
        int page,
        int pageSize,
        string? search,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await connectionFactory.OpenConnectionAsync(cancellationToken);
        var normalizedSearch = search?.Trim();
        var pattern = string.IsNullOrWhiteSpace(normalizedSearch)
            ? null
            : $"%{normalizedSearch}%";

        var parameters = new
        {
            Pattern = pattern,
            Offset = (page - 1) * pageSize,
            Limit = pageSize
        };
        var totalCount = await connection.ExecuteScalarAsync<int>(
            new CommandDefinition(
                """
                select count(*) from users
                where @Pattern is null
                   or first_name ilike @Pattern
                   or last_name ilike @Pattern
                   or email ilike @Pattern;
                """,
                parameters,
                cancellationToken: cancellationToken));

        var users = (await connection.QueryAsync<UserAccount>(
            new CommandDefinition(
                """
                select id, first_name as FirstName, last_name as LastName,
                       email, password_hash as PasswordHash,
                       created_at_utc as CreatedAtUtc
                from users
                where @Pattern is null
                   or first_name ilike @Pattern
                   or last_name ilike @Pattern
                   or email ilike @Pattern
                order by id
                offset @Offset limit @Limit;
                """,
                parameters,
                cancellationToken: cancellationToken))).AsList();

        return (users, totalCount);
    }

    public async Task<UserAccount> CreateAsync(
        UserAccount user,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await connectionFactory.OpenConnectionAsync(cancellationToken);
        return await connection.QuerySingleAsync<UserAccount>(
            new CommandDefinition(
                """
                insert into users (first_name, last_name, email, password_hash, created_at_utc)
                values (@FirstName, @LastName, @Email, @PasswordHash, @CreatedAtUtc)
                returning id, first_name as FirstName, last_name as LastName,
                          email, password_hash as PasswordHash,
                          created_at_utc as CreatedAtUtc;
                """,
                user,
                cancellationToken: cancellationToken));
    }

    public async Task<UserAccount?> UpdateAsync(
        int id,
        string firstName,
        string lastName,
        string email,
        CancellationToken cancellationToken = default)
    {
        await using var connection = await connectionFactory.OpenConnectionAsync(cancellationToken);
        return await connection.QuerySingleOrDefaultAsync<UserAccount>(
            new CommandDefinition(
                """
                update users
                set first_name = @FirstName, last_name = @LastName, email = @Email
                where id = @Id
                returning id, first_name as FirstName, last_name as LastName,
                          email, password_hash as PasswordHash,
                          created_at_utc as CreatedAtUtc;
                """,
                new { Id = id, FirstName = firstName, LastName = lastName, Email = email },
                cancellationToken: cancellationToken));
    }
}
