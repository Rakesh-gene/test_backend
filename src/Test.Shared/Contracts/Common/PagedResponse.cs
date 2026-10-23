namespace Test.Shared.Contracts.Common;

public sealed record PaginationMetadata(
    int Page,
    int PageSize,
    int TotalCount,
    int TotalPages);

public sealed record PagedResponse<T>(
    IReadOnlyList<T> Items,
    PaginationMetadata Pagination);
