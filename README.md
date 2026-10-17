# Test Backend

ASP.NET Core Web API for registering, listing, retrieving, and updating users, with Entity Framework Core and SQLite.

## Prerequisites

- .NET 10 SDK (check with `dotnet --version`).
- Access to NuGet for the initial dependency restore.

Run all commands below from the repository root, beside `test_backend.sln`.

## Project structure

- `test_backend.sln` — solution containing the application and test projects.
- `src/src.csproj` — Web API application.
- `tests/src.Tests/src.Tests.csproj` — xUnit repository and API tests.

## Build

```sh
dotnet restore test_backend.sln
dotnet build test_backend.sln --no-restore
```

To build in Release mode:

```sh
dotnet build test_backend.sln --configuration Release
```

## Run

Start the API using the HTTP development profile:

```sh
dotnet run --project src/src.csproj --launch-profile http
```

- API base URL: http://localhost:5249
- Swagger UI: http://localhost:5249/swagger

Use Swagger UI to try the user endpoints under `/api/user`. Press `Ctrl+C` in the terminal to stop the application.

The application creates its SQLite database automatically on startup. The default connection string is `Data Source=app.db`, configured in `src/appsettings.json`; running with the command above creates `src/app.db`. No separate database server or migration command is needed for initial setup.

## Test

Build and run all tests:

```sh
dotnet test test_backend.sln
```

Run only the test project:

```sh
dotnet test tests/src.Tests/src.Tests.csproj
```

Collect code coverage:

```sh
dotnet test test_backend.sln --collect:"XPlat Code Coverage"
```

Coverage reports are written beneath the test project's `TestResults` directory. Tests use in-memory SQLite databases and start their own test host, so the API does not need to be running separately.
