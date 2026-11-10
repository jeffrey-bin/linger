package document

import (
	"errors"
	"testing"
	"time"
)

func TestNativeImportRetryPolicyIsBounded(t *testing.T) {
	t.Parallel()
	if nativeImportRetryDelay(1) != time.Second || nativeImportRetryDelay(9) != 256*time.Second ||
		nativeImportRetryDelay(100) != 256*time.Second {
		t.Fatal("native import retry delay is not bounded")
	}
	for _, terminal := range []error{ErrInvalidInput, ErrAssetContentMismatch, ErrAssetQuarantined, ErrAssetQuotaExceeded, ErrRecoveryBudgetExceeded} {
		if !terminalNativeImportFailure(terminal) {
			t.Fatalf("%v should be terminal", terminal)
		}
	}
	for _, retryable := range []error{ErrRuntimeUnavailable, ErrRuntimeResultInvalid, ErrObjectStoreUnavailable, ErrAssetUnavailable, ErrAssetStorageCapacity} {
		if terminalNativeImportFailure(retryable) {
			t.Fatalf("%v should be retryable", retryable)
		}
	}
	if terminalNativeImportFailure(errors.New("unknown")) {
		t.Fatal("unknown errors should use the bounded retry path")
	}
}
