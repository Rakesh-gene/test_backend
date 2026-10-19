using src.Database;

namespace src.Migrations;

public static class AddUserEmailIndexMigration
{
    public static DatabaseMigration Definition { get; } = new(
        2,
        """
        create unique index if not exists ux_users_email_lower
            on users (lower(email));
        """);
}
