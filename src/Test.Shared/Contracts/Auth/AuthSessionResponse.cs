using Test.Shared.Contracts.Users;

namespace Test.Shared.Contracts.Auth;

public sealed record AuthSessionResponse(UserResponse User);
