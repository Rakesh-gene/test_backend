# User Controller Contract

This note locks the confirmed API shape before implementation.

## Base route

`/api/user`

## List users

`GET /api/user`

### Query parameters

- `page` - 1-based page number.
- `pageSize` - page size.
- `search` - optional free-text search.

### Search behavior

- Search is server-side.
- Search matches user name and email.
- Matching is case-insensitive.

### Response

`200 OK`

Response body must include:

- `items` - the current page of users.
- `totalCount` - total number of matching users.
- `page` - the current page number.
- `pageSize` - the page size used for the query.

### Validation / failure behavior

- Invalid `page` or `pageSize` returns `400 Bad Request`.
- Empty results return an empty `items` array with valid pagination metadata.

## Update user

`PUT /api/user/{id}`

### Allowed mutable fields

- `firstName`
- `lastName`
- `email`

### Behavior

- The endpoint updates only the allowed profile fields.
- It must not allow mass assignment of `passwordHash`, `createdAtUtc`, roles, or any other system-owned field.

### Response

- `200 OK` on success.
- `400 Bad Request` for validation failures.
- `404 Not Found` when the user does not exist.
- `409 Conflict` when the update violates the unique email constraint.

## Current gap

The current controller only exposes:

- `GET /api/user/{id}`
- `POST /api/user/register`

The list and update endpoints above still need to be implemented in the controller, repository, and tests.
