using src.Contracts.Users;

namespace src.Contracts.Auth;

public sealed record AuthSessionResponse(UserResponse User);
