namespace src.Models;

public sealed class UserAccount
{
    public int Id { get; set; }

    public required string FirstName { get; set; }

    public required string LastName { get; set; }

    public required string Email { get; set; }

    public required string PasswordHash { get; set; }

    public DateTimeOffset CreatedAtUtc { get; set; }
}
