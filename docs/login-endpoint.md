# Login Endpoint

- Route: `POST /api/user/login`
- Request content type: `application/json`
- Request body:
  - `email` - required, valid email address, max length 255
  - `password` - required, minimum length 8, maximum length 128

## Success Response

- Status: `200 OK`
- Body:
  - `user` - user profile object
    - `id`
    - `firstName`
    - `lastName`
    - `email`
    - `createdAtUtc`

## Error Responses

- `400 Bad Request` - request body fails validation
- `401 Unauthorized` - email or password is incorrect

## Notes

- Passwords are verified against the stored hash using the existing password hashing utility.
- The response intentionally does not expose whether the email address exists.
