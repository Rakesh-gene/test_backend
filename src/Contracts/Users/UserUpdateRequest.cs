using System.ComponentModel.DataAnnotations;

namespace src.Contracts.Users;

public sealed class UserUpdateRequest
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
}
