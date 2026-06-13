using Microsoft.AspNetCore.Mvc;
using src.Contracts.Users;
using src.Data.Repositories;
using src.Models;
using src.Security;

namespace src.Controllers;

[ApiController]
[Route("api/user")]
public sealed class UserController(IUserRepository userRepository) : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(UserRegistrationResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<UserRegistrationResponse>> GetById(int id, CancellationToken cancellationToken)
    {
        if (id <= 0)
        {
            return BadRequest();
        }

        var user = await userRepository.GetByIdAsync(id, cancellationToken);
        if (user is null)
        {
            return NotFound();
        }

        return Ok(Map(user));
    }

    [HttpPost("register")]
    [ProducesResponseType(typeof(UserRegistrationResponse), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<UserRegistrationResponse>> Register(
        [FromBody] UserRegistrationRequest request,
        CancellationToken cancellationToken)
    {
        var firstName = request.FirstName.Trim();
        var lastName = request.LastName.Trim();
        var email = request.Email.Trim();

        if (string.IsNullOrWhiteSpace(firstName))
        {
            ModelState.AddModelError(nameof(request.FirstName), "First name is required.");
        }

        if (string.IsNullOrWhiteSpace(lastName))
        {
            ModelState.AddModelError(nameof(request.LastName), "Last name is required.");
        }

        if (string.IsNullOrWhiteSpace(email))
        {
            ModelState.AddModelError(nameof(request.Email), "Email is required.");
        }

        if (string.IsNullOrWhiteSpace(request.Password))
        {
            ModelState.AddModelError(nameof(request.Password), "Password is required.");
        }

        if (!ModelState.IsValid)
        {
            return ValidationProblem(ModelState);
        }

        if (await userRepository.EmailExistsAsync(email, cancellationToken))
        {
            return Conflict(new ProblemDetails
            {
                Title = "Registration conflict",
                Detail = "A user with that email already exists.",
                Status = StatusCodes.Status409Conflict
            });
        }

        var user = new UserAccount
        {
            FirstName = firstName,
            LastName = lastName,
            Email = email,
            PasswordHash = PasswordHasher.Hash(request.Password),
            CreatedAtUtc = DateTime.UtcNow
        };

        var created = await userRepository.CreateAsync(user, cancellationToken);
        var response = Map(created);

        return CreatedAtAction(nameof(GetById), new { id = response.Id }, response);
    }

    private static UserRegistrationResponse Map(UserAccount user) =>
        new(user.Id, user.FirstName, user.LastName, user.Email, user.CreatedAtUtc);
}
