package document

import (
	"errors"
	"testing"
	"time"
)

func TestDecodeCursorEnforcesScopeAndPosition(t *testing.T) {
	t.Parallel()

	updated := time.Date(2026, time.August, 26, 12, 0, 0, 0, time.UTC)
	valid := cursorState{
		Kind:          "search",
		PrincipalHash: principalHash("account-a"),
		Filter:        "query-a",
		Updated:       updated,
		ID:            "document-a",
	}
	encoded, err := encodeCursor(valid)
	if err != nil {
		t.Fatal(err)
	}

	testCases := map[string]struct {
		encoded, kind, accountID, filter string
	}{
		"malformed":       {encoded: "not-base64", kind: "search", accountID: "account-a", filter: "query-a"},
		"different kind":  {encoded: encoded, kind: "library", accountID: "account-a", filter: "query-a"},
		"different actor": {encoded: encoded, kind: "search", accountID: "account-b", filter: "query-a"},
		"different query": {encoded: encoded, kind: "search", accountID: "account-a", filter: "query-b"},
	}
	for name, testCase := range testCases {

		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := decodeCursor(testCase.encoded, testCase.kind, testCase.accountID, testCase.filter); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("decodeCursor() error = %v, want ErrInvalidInput", err)
			}
		})
	}

	for name, invalid := range map[string]cursorState{
		"search without ID":      {Kind: "search", PrincipalHash: valid.PrincipalHash, Filter: valid.Filter, Updated: updated},
		"search without updated": {Kind: "search", PrincipalHash: valid.PrincipalHash, Filter: valid.Filter, ID: valid.ID},
		"version before first":   {Kind: "versions", PrincipalHash: valid.PrincipalHash, Filter: "document-a"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			invalidEncoded, encodeErr := encodeCursor(invalid)
			if encodeErr != nil {
				t.Fatal(encodeErr)
			}
			if _, decodeErr := decodeCursor(invalidEncoded, invalid.Kind, "account-a", invalid.Filter); !errors.Is(decodeErr, ErrInvalidInput) {
				t.Fatalf("decodeCursor() error = %v, want ErrInvalidInput", decodeErr)
			}
		})
	}
}

func TestSearchRejectsBlankQueryBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()

	service := &Service{}
	if _, err := service.Search(t.Context(), SearchInput{
		AccountID: "account-a",
		Query:     "   ",
		Limit:     50,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("Search() error = %v, want ErrInvalidInput", err)
	}
}
