namespace src.Data.Repositories;

public sealed class DuplicateUserEmailException : Exception
{
    public DuplicateUserEmailException(string email)
        : base($"A user with the email '{email}' already exists.")
    {
        Email = email;
    }

    public string Email { get; }
}
