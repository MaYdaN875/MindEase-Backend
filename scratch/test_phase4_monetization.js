// Compatibility entry point. The former script mutated the public application database.
// Requires TEST_DATABASE_URL pointing to localhost; the suite creates and removes its own schema.
require('ts-node/register');
require('../tests/payments.integration');
