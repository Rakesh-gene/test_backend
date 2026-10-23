using Microsoft.AspNetCore.Mvc;
using Test.Shared.Contracts.Common;
using Test.Shared.Contracts.Users;
using src.Data.Repositories;
using Test.Shared.Models;
using src.Security;

namespace src.Controllers;

[ApiController]
[Route("api/user")]
public sealed class UserController(IUserRepository userRepository) : ControllerBase
{
    private const int MaxPageSize = 100;

    [HttpGet]
    [ProducesResponseType(typeof(PagedResponse<UserResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<PagedResponse<UserResponse>>> List(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 10,
        [FromQuery] string? search = null,
        CancellationToken cancellationToken = default)
    {
        if (page <= 0)
        {
            ModelState.AddModelError(nameof(page), "Page must be greater than zero.");
        }

        if (pageSize <= 0)
        {
            ModelState.AddModelError(nameof(pageSize), "Page size must be greater than zero.");
        }
        else if (pageSize > MaxPageSize)
        {
            ModelState.AddModelError(nameof(pageSize), $"Page size must be less than or equal to {MaxPageSize}.");
        }

        if (!ModelState.IsValid)
        {
            return ValidationProblem(ModelState);
        }

        var (users, totalCount) = await userRepository.ListAsync(page, pageSize, search, cancellationToken);
        var totalPages = totalCount == 0 ? 0 : (int)Math.Ceiling(totalCount / (double)pageSize);
        var response = new PagedResponse<UserResponse>(
            users.Select(Map).ToList(),
            new PaginationMetadata(page, pageSize, totalCount, totalPages));

        return Ok(response);
    }

    [HttpGet("{id:int}")]
    [ProducesResponseType(typeof(UserResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<UserResponse>> GetById(int id, CancellationToken cancellationToken)
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

    [HttpPut("{id:int}")]
    [ProducesResponseType(typeof(UserResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<UserResponse>> Update(
        int id,
        [FromBody] UserUpdateRequest request,
        CancellationToken cancellationToken)
    {
        if (id <= 0)
        {
            ModelState.AddModelError(nameof(id), "User id must be greater than zero.");
        }

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

        if (!ModelState.IsValid)
        {
            return ValidationProblem(ModelState);
        }

        if (await userRepository.GetByIdAsync(id, cancellationToken) is null)
        {
            return NotFound();
        }

        if (await userRepository.EmailExistsForAnotherUserAsync(email, id, cancellationToken))
        {
            return Conflict(new ProblemDetails
            {
                Title = "Update conflict",
                Detail = "A user with that email already exists.",
                Status = StatusCodes.Status409Conflict
            });
        }

        var updated = await userRepository.UpdateAsync(id, firstName, lastName, email, cancellationToken);
        if (updated is null)
        {
            return NotFound();
        }

        return Ok(Map(updated));
    }

    [HttpPost("register")]
    [ProducesResponseType(typeof(UserResponse), StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<UserResponse>> Register(
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

    private static UserResponse Map(UserAccount user) =>
        new(user.Id, user.FirstName, user.LastName, user.Email, user.CreatedAtUtc);
}
