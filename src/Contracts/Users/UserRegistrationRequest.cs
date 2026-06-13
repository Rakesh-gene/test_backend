using System.ComponentModel.DataAnnotations;

namespace src.Contracts.Users;

public sealed class UserRegistrationRequest
{
    [Required]
    [StringLength(100, MinimumLength = 1)]
    public required string FirstName { get; init; }

    [Required]
    [StringLength(100, MinimumLength = 1)]
    public required string LastName { get; init; }

    [Required]
    [EmailAddress]
    [StringLength(320)]
    public required string Email { get; init; }

    [Required]
    [StringLength(128, MinimumLength = 8)]
    public required string Password { get; init; }
}
