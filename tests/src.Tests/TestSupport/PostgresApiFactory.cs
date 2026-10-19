using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace src.Tests.TestSupport;

internal sealed class PostgresApiFactory(PostgresTestDatabase database) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("ConnectionStrings:DefaultConnection", database.ConnectionString);
        builder.UseSetting("ASPNETCORE_ENVIRONMENT", "Testing");
    }
}
