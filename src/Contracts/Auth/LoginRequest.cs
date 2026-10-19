using System.ComponentModel.DataAnnotations;

namespace src.Contracts.Auth;

public sealed class LoginRequest
{
    [Required]
    [EmailAddress]
    [StringLength(255)]
    public required string Email { get; init; }

    [Required]
    [StringLength(128, MinimumLength = 8)]
    public required string Password { get; init; }
}
