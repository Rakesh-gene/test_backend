namespace src.Contracts.Users;

public sealed class UserRegistrationResponse
{
    public int Id { get; init; }

    public required string FirstName { get; init; }

    public required string LastName { get; init; }

    public required string Email { get; init; }

    public DateTimeOffset CreatedAtUtc { get; init; }
}
