package document

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// documentTransactionAttempts bounds how often a Document transaction runs
// again after PostgreSQL aborts it for serialization or a deadlock.
const documentTransactionAttempts = 3

func isRetryableDocumentTransactionError(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) &&
		(postgresError.Code == "40P01" || postgresError.Code == "40001")
}
