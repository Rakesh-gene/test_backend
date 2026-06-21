namespace src.Contracts.Users;

public sealed record UserResponse(
    int Id,
    string FirstName,
    string LastName,
    string Email,
    DateTime CreatedAtUtc);
