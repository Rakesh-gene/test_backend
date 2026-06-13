namespace src.Contracts.Users;

public sealed record UserRegistrationResponse(
    int Id,
    string FirstName,
    string LastName,
    string Email,
    DateTime CreatedAtUtc);
