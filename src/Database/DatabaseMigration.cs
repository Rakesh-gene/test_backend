namespace src.Database;

public sealed record DatabaseMigration(int Version, string Sql);
