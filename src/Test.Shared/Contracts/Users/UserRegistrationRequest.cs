using System.ComponentModel.DataAnnotations;

namespace Test.Shared.Contracts.Users;

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
    [StringLength(255)]
    public required string Email { get; init; }

    [Required]
    [StringLength(128, MinimumLength = 8)]
    public required string Password { get; init; }
}
